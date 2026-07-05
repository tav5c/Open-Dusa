// Config loader + normalizer for Open-Dusa.
//
// config.json is authored in ONE canonical shape: camelCase keys, a providers[]
// array for LLM credentials, per-agent blocks under agents{}, and a guilds{} map.
// Legacy (pre-overhaul) snake_case / flat-key configs still load — every old key
// is mapped here, and only here, with a deprecation warning at boot.
//
// runtime.json is a small mutable overlay for values the bot changes while
// running (/aimodel, /pm, iso, aiignore). The base config file is never
// rewritten at runtime, so authored formatting and secrets stay untouched.

import { existsSync, readFileSync, writeFileSync } from 'fs'

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
const RUNTIME_PATH = 'runtime.json'

// Discord snowflakes overflow Number.MAX_SAFE_INTEGER — quote bare 15+ digit
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
        keys: realKeys(p.keys ?? p.key),
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

function normalizeGuilds(raw) {
    // Canonical: one map — { "<guildId>": { ai?: bool, isolatedMemory?: bool } }
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
            `[Config] Legacy config keys detected (${legacyUsed.slice(0, 6).join(', ')}${legacyUsed.length > 6 ? ', …' : ''}) — still supported, but see README for the current shape`,
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
    }
    chat.resolved =
        resolveAgentProvider(providers, chat.provider, raw.llmBaseUrl ?? raw.llm_base_url, raw.llmKeys ?? raw.llm_keys) ??
        { baseUrl: primary.baseUrl, keys: primary.keys }

    const research = {
        provider: a.research?.provider,
        model: a.research?.model ?? raw.research_model ?? 'groq/compound-mini',
        temperature: a.research?.temperature ?? raw.researchTemp ?? 0.6,
        topP: a.research?.topP ?? raw.topP ?? 1,
        maxTokens: a.research?.maxTokens ?? raw.searchTokens ?? 1500,
    }
    research.resolved = resolveAgentProvider(providers, research.provider, raw.research_base_url, raw.research_key)

    const vision = {
        provider: a.vision?.provider,
        model: a.vision?.model ?? raw.vision_model ?? 'meta-llama/llama-4-scout-17b-16e-instruct',
        temperature: a.vision?.temperature ?? raw.visionTemp ?? 0.3,
        topP: a.vision?.topP ?? raw.topP ?? 1,
        maxTokens: a.vision?.maxTokens ?? raw.visionTokens ?? 512,
    }
    vision.resolved = resolveAgentProvider(providers, vision.provider)

    const classifier = {
        provider: a.classifier?.provider,
        model: a.classifier?.model ?? raw.classifier_model ?? 'llama-3.1-8b-instant',
        temperature: a.classifier?.temperature ?? 0,
        maxTokens: a.classifier?.maxTokens ?? 5,
    }
    classifier.resolved = resolveAgentProvider(providers, classifier.provider)

    const qa = a.quickAgent ?? raw.quickAgent ?? {}
    const quickAgent = {
        model: typeof qa.model === 'string' && qa.model.trim() ? qa.model : chat.model,
        temperature: qa.temperature ?? 0.4,
        topP: qa.topP ?? 0.9,
        maxTokens: qa.maxTokens ?? 1400,
        allowResearch: qa.allowResearch !== false,
        systemPrompt: asPrompt(qa.systemPrompt),
    }

    const guilds = normalizeGuilds(raw)
    const guildIds = Object.keys(guilds)

    return {
        token: raw.token,
        prefix: raw.prefix ?? 'med,',
        ownerId: String(raw.ownerId ?? raw.owner_id ?? ''),
        ownerName: raw.ownerName ?? raw.owner_name ?? 'My Developer',
        providers,
        agents: { chat, research, vision, classifier, quickAgent },
        fallbackModels: asArray(raw.fallbackModels ?? raw.fallback_models),
        search: {
            serperKey: raw.search?.serperKey ?? raw.serper_key ?? '',
            tavilyKey: raw.search?.tavilyKey ?? raw.tavily_key ?? '',
        },
        giphyKey: raw.giphyKey ?? raw.giphy_api_key ?? '',
        siteUrl: raw.siteUrl ?? raw.site_url ?? '',
        streaming: raw.streaming === true,
        debug: raw.debug === true,
        triggers: asArray(typeof raw.triggers === 'string' ? raw.triggers.split(',') : raw.triggers)
            .map((t) => String(t).trim().toLowerCase())
            .filter(Boolean),
        allowDMs: raw.allowDMs === true,
        memoryDepth: raw.memoryDepth,
        funMsgInterval: raw.funMsgInterval ?? raw.FunMsgInterval ?? 5400,
        pingMode: raw.pingMode ?? raw.ping_mode ?? true,
        replyPing: raw.replyPing ?? raw.reply_ping ?? true,
        stopSequences: asArray(raw.stopSequences ?? raw.stop_sequences),
        ignoreUsers: asArray(raw.ignoreUsers ?? raw.ignore_users).map(String),
        mutePhrases: asArray(raw.mutePhrases ?? raw.mute_phrases),
        banPhrases: asArray(raw.banPhrases ?? raw.ban_phrases),
        unmutePhrases: asArray(raw.unmutePhrases ?? raw.unmute_phrases),
        guilds,
        guildIds,
        aiGuildIds: guildIds.filter((id) => guilds[id].ai),
        isolatedGuildIds: guildIds.filter((id) => guilds[id].isolatedMemory),
        alwaysActiveChannels: asArray(raw.alwaysActiveChannels ?? raw.always_active_channels).map(String),
        funChannels: asArray(raw.funChannels ?? raw.fun_channels).map(String),
        // Optional keys read raw by private extensions pass through untouched
        ...Object.fromEntries(
            Object.entries(raw).filter(([k]) => k.startsWith('verify_') || k.startsWith('announcer_')),
        ),
    }
}

const RUNTIME_MUTABLE = ['chatModel', 'pingMode', 'ignoreUsers', 'isolatedGuilds', 'temperature', 'topP']
const RUNTIME_LEGACY = { aiModel: 'chatModel', ping_mode: 'pingMode', ignore_users: 'ignoreUsers', isolated_servers: 'isolatedGuilds' }

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
    if (runtime.pingMode !== undefined) config.pingMode = runtime.pingMode
    if (Array.isArray(runtime.ignoreUsers)) config.ignoreUsers = runtime.ignoreUsers.map(String)
    if (Array.isArray(runtime.isolatedGuilds)) {
        for (const id of runtime.isolatedGuilds.map(String))
            (config.guilds[id] ??= { ai: true }).isolatedMemory = true
        config.isolatedGuildIds = Object.keys(config.guilds).filter((id) => config.guilds[id].isolatedMemory)
    }
    if (Object.keys(runtime).length) console.log('[Config] Applied runtime.json overrides')
    console.log(`[Config] ${config.providers.length} provider(s), ${config.guildIds.length} guild(s) in scope`)
    _cached = config
    return config
}
