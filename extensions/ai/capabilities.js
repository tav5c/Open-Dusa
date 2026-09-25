// Model capability registry for OpenAI-compatible providers.
//
// Why this exists: GET /v1/models on Groq / NVIDIA NIM / private aggregators
// returns identity only (id, owned_by) — no vision/tools/streaming flags.
// OpenRouter is the only provider with a real capability API
// (architecture.input_modalities + supported_parameters). So: static registry
// seeded from provider docs (exact ids + conservative family patterns).
// Unknown ids assume vision false, tools true (cheap to attempt, classified
// on 400).
//
// Docs pinned 2026-09: Groq vision https://console.groq.com/docs/vision,
// tool use https://console.groq.com/docs/tool-use/overview,
// structured https://console.groq.com/docs/structured-outputs,
// NIM function calling https://docs.nvidia.com/nim/large-language-models/latest/function-calling.html.

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
