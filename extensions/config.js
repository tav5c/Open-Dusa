// Config loader + normalizer for Open-Dusa.
//
// config.json is authored in ONE canonical shape: camelCase keys, a providers[]
// array for LLM credentials, per-agent blocks under agents{}, and a guilds{} map.
// Legacy (pre-overhaul) snake_case / flat-key configs still load, every old key
// is mapped here, and only here, with a deprecation warning at boot.
//
// configs/runtime.json is a small mutable overlay for values the bot changes
// while running (/isolation). config.json itself is only touched by
// /ai-pause (per-guild ai flag) and /configclean.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'

// Zero-dependency .env support, loaded once at import time so every later
// process.env read (notably db.js's DB_ENCRYPTION_KEY) sees it. Real
// environment variables always win over .env entries; blank values are kept
// falsy so `KEY=` or an empty file behaves exactly like no .env at all.
if (existsSync('.env')) {
    for (const line of readFileSync('.env', 'utf8').split('\n')) {
        if (line.trimStart().startsWith('#')) continue
        const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
        if (m) process.env[m[1]] ??= m[2].replace(/^(["'])(.*)\1$/, '$2')
    }
}

const CONFIG_PATH = 'config.json'
const RUNTIME_PATH = 'configs/runtime.json'

// One-time move of generated files that used to live in the repo root.
try {
    mkdirSync('configs', { recursive: true })
    if (existsSync('runtime.json') && !existsSync(RUNTIME_PATH)) renameSync('runtime.json', RUNTIME_PATH)
} catch {}

// Discord snowflakes overflow Number.MAX_SAFE_INTEGER, quote bare 15+ digit
// numbers before parsing so unquoted IDs can't get silently corrupted.
const parseSnowflakeSafe = (raw) =>
    JSON.parse(raw.replace(/(?<=:\s*|\[\s*|,\s*)\b(\d{15,})\b(?=\s*[,}\]])/g, '"$1"'))

const asArray = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v])
const asPrompt = (v) => (Array.isArray(v) ? v.join('\n') : typeof v === 'string' ? v : '')
const realKeys = (v) => asArray(v).filter((k) => typeof k === 'string' && k.trim().length > 0)

function normalizeProviders(raw) {
    const entries = asArray(raw.providers).map((p) => ({
        name: p.name ?? 'provider',
        baseUrl: p.baseUrl ?? p.base_url ?? '',
        keys: [...new Set(realKeys(p.keys ?? p.key))], // dupes collapse to one slot, they share the same org quota anyway
        model: p.model,
        priority: p.priority ?? 99,
    }))
    // Legacy flat pair joins the pool so old configs keep routing identically
    const flatUrl = raw.llmBaseUrl ?? raw.llm_base_url
    const flatKeys = realKeys(raw.llmKeys ?? raw.llm_keys)
    if (flatUrl && flatKeys.length && !entries.some((p) => p.baseUrl === flatUrl))
        entries.push({ name: 'legacy-flat', baseUrl: flatUrl, keys: flatKeys, priority: entries.length + 1 })
    // Merge duplicate entries (same name + baseUrl): keys concatenate, best priority wins
    const merged = new Map()
    for (const p of entries) {
        const id = `${p.name}|${p.baseUrl}`
        const prev = merged.get(id)
        if (!prev) merged.set(id, { ...p, keys: [...p.keys] })
        else {
            prev.keys.push(...p.keys.filter((k) => !prev.keys.includes(k)))
            prev.priority = Math.min(prev.priority, p.priority)
            prev.model ??= p.model
        }
    }
    return [...merged.values()].sort((a, b) => a.priority - b.priority)
}

function resolveAgentProvider(providers, providerName, legacyUrl, legacyKeys) {
    if (providerName) {
        const p = providers.find((x) => x.name === providerName)
        if (p) return { baseUrl: p.baseUrl, keys: p.keys }
        console.warn(`[Config] agents.*.provider '${providerName}' not found in providers[]`)
    }
    if (legacyUrl) {
        const keys = realKeys(legacyKeys)
        const pool = providers.find((x) => x.baseUrl === legacyUrl)
        return { baseUrl: legacyUrl, keys: keys.length ? keys : (pool?.keys ?? []) }
    }
    return null
}

// Per-agent fallback chains: [{ provider?, model }]. A plain string means
// "same provider as the agent". Each entry resolves to {provider, baseUrl,
// keys, model}; unresolvable entries (unknown provider, blank model, keyless
// pool) are skipped with a warning so one bad line can't break the chain.
function parseFallbackString(t, ownResolved, providers) {
    // "provider/model" pair when the head names a configured provider
    // ("groq/compound"), otherwise the whole string is a model ID on the
    // agent's own provider ("qwen/qwen3.8-max", "mistralai/...").
    const slash = t.indexOf('/')
    const head = slash > 0 ? t.slice(0, slash) : ''
    if (head && providers.some((x) => x.name === head)) {
        const p = providers.find((x) => x.name === head)
        const model = t.slice(slash + 1).trim()
        if (model && p.keys?.length) return { provider: p.name, baseUrl: p.baseUrl, keys: p.keys, model }
        return null
    }
    if (!ownResolved?.baseUrl || !ownResolved?.keys?.length) return null
    return { provider: null, baseUrl: ownResolved.baseUrl, keys: ownResolved.keys, model: t }
}
function resolveFallbacks(list, ownResolved, providers) {
    const out = []
    const push = (fb) => {
        if (fb && !out.some((x) => x.model === fb.model && x.baseUrl === fb.baseUrl)) out.push(fb)
    }
    // Group form: { provider: "xkiro", models: [...] } expands in order,
    // each model resolving against the group provider by default.
    const items = []
    for (const entry of asArray(list)) {
        if (entry && typeof entry === 'object' && !Array.isArray(entry) && Array.isArray(entry.models)) {
            const p = entry.provider ? providers.find((x) => x.name === entry.provider) : null
            if (entry.provider && (!p || !p.keys?.length)) {
                console.warn(
                    `[Config] fallback group provider '${entry.provider}' not found or keyless, skipping`,
                )
                continue
            }
            const own = p ? { provider: p.name, baseUrl: p.baseUrl, keys: p.keys } : ownResolved
            for (const m of entry.models) {
                if (typeof m === 'string') items.push({ text: m, own })
                else if (m && typeof m === 'object')
                    items.push({ obj: m.provider ? m : { ...m, provider: entry.provider }, own })
            }
            continue
        }
        items.push(
            typeof entry === 'string' ? { text: entry, own: ownResolved } : { obj: entry, own: ownResolved },
        )
    }
    for (const { text, obj, own } of items) {
        if (typeof text === 'string') {
            // Comma-separated pairs allowed: "groq/compound, groq/compound-mini"
            for (const part of text.split(',')) {
                const t = part.trim()
                if (!t) continue
                push(parseFallbackString(t, own, providers))
            }
        } else if (obj && typeof obj === 'object') {
            const model = typeof obj.model === 'string' ? obj.model.trim() : ''
            if (!model) continue
            if (obj.provider) {
                const p = providers.find((x) => x.name === obj.provider)
                if (!p || !p.keys?.length) {
                    console.warn(
                        `[Config] fallback provider '${obj.provider}' not found or keyless, skipping`,
                    )
                    continue
                }
                push({ provider: p.name, baseUrl: p.baseUrl, keys: p.keys, model })
            } else if (own?.baseUrl && own?.keys?.length) {
                push({ provider: null, baseUrl: own.baseUrl, keys: own.keys, model })
            }
        }
    }
    return out
}
// Collects both spellings: "fallback" (compact string, tried first) and
// "fallbacks" (array of strings/objects).
function fallbackRaw(agent) {
    const out = []
    if (typeof agent?.fallback === 'string') out.push(agent.fallback)
    else out.push(...asArray(agent?.fallback))
    out.push(...asArray(agent?.fallbacks))
    return out
}

function normalizeGuilds(raw) {
    // Canonical: one map, { "<guildId>": { ai?: bool, isolatedMemory?: bool } }
    if (raw.guilds && typeof raw.guilds === 'object' && !Array.isArray(raw.guilds)) {
        const out = {}
        for (const [id, g] of Object.entries(raw.guilds))
            out[String(id)] = { ai: g?.ai !== false, isolatedMemory: g?.isolatedMemory === true }
        return out
    }
    // Legacy: three parallel arrays collapse into the map. Empty ai list = AI
    // allowed everywhere (matches the documented "empty allows all" behavior).
    const out = {}
    const ai = new Set(asArray(raw.ai_allowed_guilds ?? raw.aiAllowedGuilds).map(String))
    const iso = new Set(asArray(raw.isolated_servers ?? raw.isolatedServers).map(String))
    for (const id of asArray(raw.guilds).map(String))
        out[id] = { ai: ai.size ? ai.has(id) : true, isolatedMemory: iso.has(id) }
    for (const id of iso) out[id] ??= { ai: ai.size ? ai.has(id) : true, isolatedMemory: true }
    return out
}

// prettier-ignore
const LEGACY_KEYS = [
    'owner_id', 'owner_name', 'llm_base_url', 'llm_keys', 'research_base_url', 'research_key',
    'aiModel', 'research_model', 'vision_model', 'classifier_model', 'fallback_models',
    'chatTokens', 'researchTemp', 'searchTokens', 'visionTemp', 'visionTokens',
    'ai_allowed_guilds', 'always_active_channels', 'fun_channels', 'isolated_servers',
    'ignore_users', 'ping_mode', 'reply_ping', 'stop_sequences', 'FunMsgInterval',
    'serper_key', 'tavily_key', 'giphy_api_key', 'mute_phrases', 'ban_phrases',
    'unmute_phrases', 'site_url',
]

export function normalizeConfig(raw) {
    const legacyUsed = LEGACY_KEYS.filter((k) => raw[k] !== undefined)
    if (legacyUsed.length)
        console.warn(
            `[Config] Legacy config keys detected (${legacyUsed.slice(0, 6).join(', ')}${legacyUsed.length > 6 ? ', …' : ''}), still supported, but see README for the current shape`,
        )

    const providers = normalizeProviders(raw)
    const primary = providers[0] ?? { baseUrl: 'https://api.groq.com/openai/v1', keys: [] }
    const a = raw.agents ?? {}

    const chat = {
        provider: a.chat?.provider,
        model: a.chat?.model ?? raw.aiModel ?? 'openai/gpt-oss-120b',
        temperature: a.chat?.temperature ?? raw.temperature ?? 0.9,
        topP: a.chat?.topP ?? raw.topP ?? 1,
        maxTokens: a.chat?.maxTokens ?? raw.chatTokens ?? 1024,
        systemPrompt: asPrompt(a.chat?.systemPrompt ?? raw.systemPrompt),
        identity: asPrompt(a.chat?.identity ?? raw.identity),
    }
    chat.resolved = resolveAgentProvider(
        providers,
        chat.provider,
        raw.llmBaseUrl ?? raw.llm_base_url,
        raw.llmKeys ?? raw.llm_keys,
    ) ?? { baseUrl: primary.baseUrl, keys: primary.keys }
    chat.fallbacks = resolveFallbacks(fallbackRaw(a.chat), chat.resolved, providers)

    const research = {
        provider: a.research?.provider,
        model: a.research?.model ?? raw.research_model ?? 'groq/compound-mini',
        temperature: a.research?.temperature ?? raw.researchTemp ?? 0.6,
        topP: a.research?.topP ?? raw.topP ?? 1,
        maxTokens: a.research?.maxTokens ?? raw.searchTokens ?? 1500,
    }
    research.resolved = resolveAgentProvider(
        providers,
        research.provider,
        raw.research_base_url,
        raw.research_key,
    )
    research.fallbacks = resolveFallbacks(fallbackRaw(a.research), research.resolved, providers)

    const vision = {
        provider: a.vision?.provider,
        model: a.vision?.model ?? raw.vision_model ?? 'meta-llama/llama-4-scout-17b-16e-instruct',
        temperature: a.vision?.temperature ?? raw.visionTemp ?? 0.3,
        topP: a.vision?.topP ?? raw.topP ?? 1,
        maxTokens: a.vision?.maxTokens ?? raw.visionTokens ?? 512,
    }
    vision.resolved = resolveAgentProvider(providers, vision.provider)
    vision.fallbacks = resolveFallbacks(fallbackRaw(a.vision), vision.resolved, providers)

    // The classifier rides the NIM provider by default when one is configured:
    // YES/NO routing is tiny but frequent, no reason to let it nibble the primary's
    // daily token budget. The 2.5s race in research.js caps any latency cost, a
    // timeout just means "answer without searching". Explicit config still wins.
    const clfProvider = a.classifier?.provider ?? providers.find((p) => p.baseUrl?.includes('nvidia'))?.name
    const clfResolved = resolveAgentProvider(providers, clfProvider)
    const classifier = {
        provider: clfProvider,
        model:
            a.classifier?.model ??
            raw.classifier_model ??
            // llama-3.1-8b-instant is DEAD on groq (404s every call, burning the
            // full 2.5s race) — default non-NVIDIA installs to a live cheap
            // model instead. Explicit config still wins above.
            (clfResolved?.baseUrl?.includes('nvidia') ? 'meta/llama-3.1-8b-instruct' : 'openai/gpt-oss-20b'),
        temperature: a.classifier?.temperature ?? 0,
        maxTokens: a.classifier?.maxTokens ?? 64,
    }
    classifier.resolved = clfResolved
    classifier.fallbacks = resolveFallbacks(fallbackRaw(a.classifier), clfResolved, providers)

    const qa = a.quickAgent ?? raw.quickAgent ?? {}
    const quickAgent = {
        model: typeof qa.model === 'string' && qa.model.trim() ? qa.model : chat.model,
        temperature: qa.temperature ?? 0.4,
        topP: qa.topP ?? 0.9,
        maxTokens: qa.maxTokens ?? 1400,
        allowResearch: qa.allowResearch !== false,
        systemPrompt: asPrompt(qa.systemPrompt),
        // No own provider: plain-string fallbacks are skipped, entries with an
        // explicit provider still resolve.
        fallbacks: resolveFallbacks(fallbackRaw(qa), null, providers),
    }

    // Legacy top-level fallbackModels: historically tried on the chat provider
    // only. Merged into the chat chain (deduped) so there is exactly one
    // fallback path instead of two. Entries use the same pair syntax.
    for (const fb of resolveFallbacks(
        asArray(raw.fallbackModels ?? raw.fallback_models),
        chat.resolved,
        providers,
    )) {
        if (!chat.fallbacks.some((f) => f.model === fb.model && f.baseUrl === fb.baseUrl))
            chat.fallbacks.push({ ...fb, provider: fb.provider ?? chat.provider ?? null })
    }

    const guilds = normalizeGuilds(raw)
    const guildIds = Object.keys(guilds)

    const prefix = typeof raw.prefix === 'string' && raw.prefix.trim() ? raw.prefix.trim() : 'med,'
    const prefixes = [...new Set([prefix, ...asArray(raw.prefixAliases ?? raw.prefix_aliases)])]
        .filter((value) => typeof value === 'string' && value.trim())
        .map((value) => value.trim())
        .sort((a, b) => b.length - a.length)

    return {
        token: raw.token,
        prefix,
        prefixes,
        ownerId: String(raw.ownerId ?? raw.owner_id ?? ''),
        ownerName: raw.ownerName ?? raw.owner_name ?? 'My Developer',
        providers,
        agents: { chat, research, vision, classifier, quickAgent },
        fallbackModels: asArray(raw.fallbackModels ?? raw.fallback_models),
        search: {
            // Master switch: false disables every web-research path
            // (chat routing, slash commands, second thoughts). Explicit
            // per-command "on" gets a disabled notice instead of silence.
            // Defaults to true.
            enabled: raw.search?.enabled !== false,
            serperKey: raw.search?.serperKey ?? raw.serper_key ?? '',
            // Tavily accepts one key or an array — spares rotate in on
            // rate-limit/quota errors. tavilyKey stays the first (compat).
            tavilyKeys: asArray(
                raw.search?.tavilyKeys ?? raw.search?.tavilyKey ?? raw.tavily_key ?? [],
            ).filter((k) => typeof k === 'string' && k.trim()),
            tavilyKey:
                asArray(raw.search?.tavilyKeys ?? raw.search?.tavilyKey ?? raw.tavily_key ?? []).find(
                    (k) => typeof k === 'string' && k.trim(),
                ) ?? '',
        },
        giphyKey: raw.giphyKey ?? raw.giphy_api_key ?? '',
        klipyKey: raw.klipyKey ?? raw.klipy_key ?? '',
        siteUrl: raw.siteUrl ?? raw.site_url ?? '',
        streaming: raw.streaming === true,
        // Debug mode (single flag): owner-only replies, no passive buffering,
        // prod DBs untouched (ephemeral debug DB wiped on boot), verbose
        // logging. Toggle live via owner-only /debugmode (hot-swaps, no reboot).
        debug: raw.debug === true,
        // Censor toggle: true disables every code-level NSFW/dangerous/hate refusal
        // (routing + canned replies + slur guard) so the models judge content
        // themselves. Defaults to false (safe).
        nsfw: raw.nsfw === true,
        // Token saver: true prefers fixed replies for trivial intents
        // (greetings, acks, self-status) and Tavily-direct research, skipping
        // LLM calls where templates do. False = full generative everywhere.
        tokenSaver: raw.tokenSaver === true,
        triggers: asArray(typeof raw.triggers === 'string' ? raw.triggers.split(',') : raw.triggers)
            .map((t) => String(t).trim().toLowerCase())
            .filter(Boolean),
        allowDMs: raw.allowDMs === true,
        // Memory master switch: false means no stored reads or writes for
        // anyone (conversations, interests, summaries, timezones, room
        // buffer). Prompts, modes, streams, and /forgetme keep working —
        // those are settings and deletion, not memories. Per-user /memory
        // still applies on top when this is true. Defaults to true.
        memory: raw.memory !== false,
        memoryDepth: raw.memoryDepth,
        funMsgInterval: raw.funMsgInterval ?? raw.FunMsgInterval ?? 5400,
        stopSequences: asArray(raw.stopSequences ?? raw.stop_sequences),
        ignoreUsers: asArray(raw.ignoreUsers ?? raw.ignore_users).map(String),
        mutePhrases: asArray(raw.mutePhrases ?? raw.mute_phrases),
        banPhrases: asArray(raw.banPhrases ?? raw.ban_phrases),
        unmutePhrases: asArray(raw.unmutePhrases ?? raw.unmute_phrases),
        guilds,
        guildIds,
        aiDisabledGuildIds: guildIds.filter((id) => !guilds[id].ai),
        isolatedGuildIds: guildIds.filter((id) => guilds[id].isolatedMemory),
        alwaysActiveChannels: asArray(raw.alwaysActiveChannels ?? raw.always_active_channels).map(String),
        funChannels: asArray(raw.funChannels ?? raw.fun_channels).map(String),
        // Optional keys read raw by private extensions pass through untouched
        ...Object.fromEntries(
            Object.entries(raw).filter(([k]) => k.startsWith('verify_') || k.startsWith('announcer_')),
        ),
    }
}

const RUNTIME_MUTABLE = ['chatModel', 'isolatedGuilds', 'temperature', 'topP']
const RUNTIME_LEGACY = { aiModel: 'chatModel', isolated_servers: 'isolatedGuilds' }

function readRuntime() {
    try {
        if (!existsSync(RUNTIME_PATH)) return {}
        const raw = parseSnowflakeSafe(readFileSync(RUNTIME_PATH, 'utf8'))
        for (const [oldKey, newKey] of Object.entries(RUNTIME_LEGACY))
            if (raw[oldKey] !== undefined && raw[newKey] === undefined) raw[newKey] = raw[oldKey]
        return raw
    } catch (e) {
        console.warn('[Config] runtime.json unreadable, ignoring:', e.message)
        return {}
    }
}

export function saveRuntime(patch) {
    try {
        const existing = readRuntime()
        for (const key of RUNTIME_MUTABLE) if (patch[key] !== undefined) existing[key] = patch[key]
        for (const legacy of Object.keys(RUNTIME_LEGACY)) delete existing[legacy]
        writeFileSync(RUNTIME_PATH, JSON.stringify(existing, null, 2), 'utf8')
    } catch (e) {
        console.error('[Config] runtime save error:', e)
    }
}

export function readConfigRaw() {
    return parseSnowflakeSafe(readFileSync(CONFIG_PATH, 'utf8'))
}

export function writeConfigRaw(raw) {
    writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2) + '\n', 'utf8')
}

// Flip per-guild flags (like /ai-pause's { ai: false }) in the authored config.
// Pass undefined to drop a key; empty guild entries fall off entirely.
export function setConfigGuild(guildId, patch) {
    try {
        const raw = readConfigRaw()
        const guilds =
            raw.guilds && typeof raw.guilds === 'object' && !Array.isArray(raw.guilds) ? raw.guilds : {}
        const entry = { ...(guilds[String(guildId)] ?? {}) }
        for (const [k, v] of Object.entries(patch)) {
            if (v === undefined) delete entry[k]
            else entry[k] = v
        }
        if (Object.keys(entry).length) guilds[String(guildId)] = entry
        else delete guilds[String(guildId)]
        if (Object.keys(guilds).length) raw.guilds = guilds
        else delete raw.guilds
        writeConfigRaw(raw)
    } catch (e) {
        console.error('[Config] config.json update failed:', e)
    }
}

let _cached = null

export function loadConfig() {
    if (_cached) return _cached
    let raw = {}
    try {
        raw = parseSnowflakeSafe(readFileSync(CONFIG_PATH, 'utf8'))
    } catch (e) {
        console.error('[Config] Could not read config.json:', e.message)
    }
    const config = normalizeConfig(raw)
    const runtime = readRuntime()
    if (runtime.chatModel) config.agents.chat.model = runtime.chatModel
    if (runtime.temperature !== undefined) config.agents.chat.temperature = runtime.temperature
    if (runtime.topP !== undefined) config.agents.chat.topP = runtime.topP
    if (Array.isArray(runtime.isolatedGuilds)) {
        for (const id of runtime.isolatedGuilds.map(String))
            (config.guilds[id] ??= { ai: true }).isolatedMemory = true
        config.isolatedGuildIds = Object.keys(config.guilds).filter((id) => config.guilds[id].isolatedMemory)
    }
    if (Object.keys(runtime).length) console.log('[Config] Applied runtime.json overrides')
    // Mirror the censor toggle for config-less modules (safety.js): true means
    // the models judge content themselves. Requires a restart to take effect,
    // like every other config value.
    globalThis._medusaNsfw = config.nsfw === true
    if (config.nsfw) console.log('[Config] Censor toggle ON (nsfw:true) — code-level refusals disabled')
    const keyCounts = config.providers
        .map((p) => `${p.name}: ${p.keys.length} key${p.keys.length === 1 ? '' : 's'}`)
        .join(', ')
    console.log(
        `[Config] ${config.providers.length} provider(s) [${keyCounts}], ${config.guildIds.length} guild(s) in scope`,
    )
    _cached = config
    return config
}
