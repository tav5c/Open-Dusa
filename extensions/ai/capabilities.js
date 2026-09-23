// Model capability registry + live probe for OpenAI-compatible providers.
//
// Why this exists: GET /v1/models on Groq / NVIDIA NIM / private aggregators
// returns identity only (id, owned_by) — no vision/tools/streaming flags.
// OpenRouter is the only provider with a real capability API
// (architecture.input_modalities + supported_parameters). So: static registry
// seeded from provider docs, refreshed by id-set diff, plus a fail-closed
// live probe (max_tokens:1, never user data) for unknown ids. Results cache
// per provider|model.
//
// Docs pinned 2026-09: Groq vision https://console.groq.com/docs/vision,
// tool use https://console.groq.com/docs/tool-use/overview,
// structured https://console.groq.com/docs/structured-outputs,
// NIM function calling https://docs.nvidia.com/nim/large-language-models/latest/function-calling.html.

const CACHE_TTL_MS = 6 * 60 * 60 * 1000
const _cache = new Map() // "<baseUrl>|<model>" -> { caps, at }

// Exact-id seeds: { vision, tools, parallelTools, jsonObject, jsonSchemaStrict, maxImages, builtInTools }
const KNOWN = {
    'qwen/qwen3-vl-32b': {
        vision: true,
        tools: true,
        parallelTools: true,
        jsonObject: true,
        jsonSchemaStrict: true,
        maxImages: 3,
        builtInTools: false,
    },
    'openai/gpt-oss-120b': {
        vision: false,
        tools: true,
        parallelTools: true,
        jsonObject: true,
        jsonSchemaStrict: true,
        maxImages: 0,
        builtInTools: true,
        // No server-side browsing without an explicit browser_search tool
        // attached (Groq docs: opt-in). False so research falls through to
        // the Tavily tool loop instead of shipping a memory answer with a
        // 🔍 footer.
        webSearch: false,
    },
    'openai/gpt-oss-20b': {
        vision: false,
        tools: true,
        parallelTools: true,
        jsonObject: true,
        jsonSchemaStrict: true,
        maxImages: 0,
        builtInTools: true,
        // Same as gpt-oss-120b: no implicit browsing.
        webSearch: false,
    },
    'groq/compound': {
        vision: false,
        tools: true,
        parallelTools: true,
        jsonObject: true,
        jsonSchemaStrict: false,
        maxImages: 0,
        builtInTools: true,
        webSearch: true,
    },
    'groq/compound-mini': {
        vision: false,
        tools: true,
        parallelTools: false,
        jsonObject: true,
        jsonSchemaStrict: false,
        maxImages: 0,
        builtInTools: true,
        webSearch: true,
    },
    'nvidia/nemotron-nano-12b-v2-vl': {
        vision: true,
        tools: false,
        parallelTools: false,
        jsonObject: true,
        jsonSchemaStrict: false,
        maxImages: 1,
        builtInTools: false,
    },
    'meta/llama-3.1-8b-instruct': {
        vision: false,
        tools: true,
        parallelTools: true,
        jsonObject: true,
        jsonSchemaStrict: false,
        maxImages: 0,
        builtInTools: false,
    },
    'mistralai/mistral-small-4-119b-2603': {
        vision: false,
        tools: true,
        parallelTools: true,
        jsonObject: true,
        jsonSchemaStrict: false,
        maxImages: 0,
        builtInTools: false,
    },
}

// Family patterns for ids not in KNOWN (checked in order). Conservative:
// unknown => vision false, tools true (cheap to attempt, classified on 400).
const FAMILY = [
    { re: /vl\b|vision|scout|qwen.*3.*(27b|32b)|nemotron.*vl/i, caps: { vision: true, maxImages: 3 } },
    { re: /sonar|perplexity/i, caps: { tools: true, jsonObject: true, webSearch: true } },
    { re: /gpt-oss|compound/i, caps: { tools: true, jsonObject: true, webSearch: true } },
    {
        re: /llama-3|mistral|qwen|deepseek|moonshot|grok/i,
        caps: { tools: true, jsonObject: true },
    },
]

const _base = (seed = {}) => ({
    vision: false,
    tools: true,
    parallelTools: false,
    jsonObject: true,
    jsonSchemaStrict: false,
    maxImages: 0,
    // Endpoint-level, never per-chat-model: no OpenAI-compatible chat API
    // takes video_url today (Groq/NIM/OpenAI all 400) — send frames as images.
    video: false,
    // File parts (input_file/file_id) are Responses-API only; chat takes image_url.
    file: false,
    // Separate POST /v1/images/generations, never chat completions.
    imageGen: false,
    // Server-side exec exists only as Groq built-in tools (compound/gpt-oss).
    codeExec: false,
    // Native web research: server-side browsing/search built into the model
    // (Groq compound, gpt-oss built-ins, Perplexity sonar, Grok live-search).
    // true = Tavily round can be skipped/saved; false/unknown = search via
    // tools as today. Registry-only: undetectable via cheap probe.
    webSearch: false,
    // Streaming is per-request (stream:true), not per-model; always attemptable.
    stream: true,
    ...seed,
})

export function staticCaps(model = '') {
    const id = String(model).trim()
    if (KNOWN[id])
        return { ..._base(KNOWN[id]), builtInTools: KNOWN[id].builtInTools, source: 'registry:exact' }
    const caps = _base()
    for (const f of FAMILY) {
        if (f.re.test(id)) {
            Object.assign(caps, f.caps)
            caps.source = 'registry:family'
            return caps
        }
    }
    caps.source = 'registry:default'
    return caps
}

const _key = (model, baseUrl) => `${baseUrl ?? ''}|${model}`

/**
 * Fail-closed probe: three max_tokens:1 calls (image_url, dummy tools,
 * json_object). Any 2xx => supported; 400-shape => unsupported; anything
 * else (429/5xx/network) => null (unknown, keep static value).
 */
export async function probeCaps(client, model, { timeoutMs = 10_000 } = {}) {
    const out = {}
    const tryCall = async (body) => {
        const ctrl = new AbortController()
        const t = setTimeout(() => ctrl.abort(), timeoutMs)
        try {
            await client.chat.completions.create(
                { model, max_tokens: 1, stream: false, ...body },
                { signal: ctrl.signal },
            )
            return true
        } catch (e) {
            const s = `${e?.status ?? ''} ${e?.message ?? e}`.toLowerCase()
            if (/(model.*(image|vision)|image.*(support|model)|unsupported.*image|invalid.*image)/.test(s))
                return false
            if (
                /(tool|function|json_schema|response_format|parallel)/.test(s) &&
                /400|422|unsupported|invalid|not supported/.test(s)
            )
                return false
            if (/\b(400|404|422)\b/.test(s)) return false
            return null // rate-limit / server / network: unknown, don't learn
        } finally {
            clearTimeout(t)
        }
    }
    const PIXEL =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    out.vision = await tryCall({
        messages: [
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'hi' },
                    { type: 'image_url', image_url: { url: PIXEL } },
                ],
            },
        ],
    })
    out.tools = await tryCall({
        messages: [{ role: 'user', content: 'hi' }],
        tools: [
            {
                type: 'function',
                function: {
                    name: '__cap_probe',
                    description: 'capability probe',
                    parameters: { type: 'object', properties: {} },
                },
            },
        ],
        tool_choice: 'auto',
    })
    out.jsonObject = await tryCall({
        messages: [{ role: 'user', content: 'hi' }],
        response_format: { type: 'json_object' },
    })
    return out
}

/**
 * Merged answer: static registry wins unless the probe positively proves
 * otherwise (probe false => downgrade; probe null => keep static).
 * Pass a client to probe unknown ids; without one it's registry-only.
 */
export async function getModelCaps(model, { baseUrl = '', client = null, allowProbe = true } = {}) {
    const ck = _key(model, baseUrl)
    const hit = _cache.get(ck)
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.caps
    const caps = staticCaps(model)
    if (client && allowProbe && (caps.source !== 'registry:exact' || caps.vision)) {
        try {
            const p = await probeCaps(client, model)
            for (const k of ['vision', 'tools', 'jsonObject']) {
                if (p[k] === false) caps[k] = false
                else if (p[k] === true && caps.source !== 'registry:exact') caps[k] = true
            }
            caps.source += '+probe'
        } catch {}
    }
    if (String(model).includes('compound') || String(model).includes('gpt-oss')) caps.codeExec = true
    _cache.set(ck, { caps, at: Date.now() })
    return caps
}

export function clearCapsCache() {
    _cache.clear()
}
