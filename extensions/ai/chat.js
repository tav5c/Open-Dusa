// Chat core: context assembly, trigger decisions, generation (stateful +
// quick-agent stateless), research responses, and the message pipeline.
import crypto from 'crypto'
import {
    ActionRowBuilder,
    ComponentType,
    MessageFlags,
    PermissionFlagsBits,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
} from 'discord.js'
import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    unlinkSync,
    writeFileSync,
} from 'fs'
import { LRUCache } from 'lru-cache'
import { join } from 'path'
import { performance } from 'perf_hooks'
import { loadPerformance } from '../performance.js'
import {
    CAPABILITIES_NOTE,
    DESTRUCTIVE_CMDS,
    NEVER_RESEARCH_PREFIXES,
    NO_SEARCH_SIGNALS,
    SEARCH_EMOJIS,
    makeIdSet,
} from './constants.js'
import { AIMemoryManager, GhostUsers } from './memory.js'
import { FairQueue, estTokens } from './fairqueue.js'
import { getLocalTimeLine, getSavedTimezone, lookupLocation, saveUserTimezone } from '../timezones.js'
import { MOD_CMDS, CMD_PERMS } from './agent-commands.js'
import { OutputCore } from './output.js'
import { SAFETY_POLICY, claimsWrongIdentity, containsDisallowedHate, safetyRefusal } from './safety.js'

const PERF = loadPerformance()

// Pure migration: legacy split user files -> merged {users, servers} shape.
// loadFn(path, fallback) abstracts disk for tests. Ghost scopes "gid:uid"
// fold into users[uid].ghost[gid].
export function migrateLegacyUsers(loadFn) {
    const out = { users: {}, servers: {} }
    const modes = loadFn('data/ai/user_modes.json', {})
    const prompts = loadFn('data/ai/custom_prompts.json', {})
    const servers = loadFn('data/ai/server_prompts.json', {})
    const ghosts = loadFn('data/ai/ghost_users.json', {})
    for (const [uid, v] of Object.entries(modes ?? {})) (out.users[uid] ??= {}).mode = v
    for (const [uid, v] of Object.entries(prompts ?? {})) (out.users[uid] ??= {}).prompt = v
    for (const [scope, tids] of Object.entries(ghosts ?? {})) {
        const i = String(scope).lastIndexOf(':')
        if (i < 0 || !Array.isArray(tids)) continue
        const gid = scope.slice(0, i)
        const uid = scope.slice(i + 1)
        ;((out.users[uid] ??= {}).ghost ??= {})[gid] = tids
    }
    for (const [gid, p] of Object.entries(servers ?? {})) (out.servers[gid] ??= {}).persona = p
    return out
}

// Pure merge for the users file: live maps win per-key, but entries that
// only exist in the previous file content survive (migration boots,
// mid-hydration saves). Returns { users, servers }.
export function mergeUsersData(prevU, prevS, maps, pruneAbsent = false) {
    const users = {}
    const ids = new Set([
        ...Object.keys(prevU ?? {}),
        ...Object.keys(maps.userModes ?? {}),
        ...Object.keys(maps.customPrompts ?? {}),
        ...Object.keys(maps.userStreams ?? {}),
        ...Object.keys(maps.userMemory ?? {}),
    ])
    for (const uid of ids) {
        const entry = { ...(prevU?.[uid] ?? {}) }
        if (maps.userModes?.[uid] !== undefined) entry.mode = maps.userModes[uid]
        else if (pruneAbsent) delete entry.mode
        if (typeof maps.customPrompts?.[uid] === 'string') entry.prompt = maps.customPrompts[uid]
        else if (pruneAbsent) delete entry.prompt
        if (maps.userStreams?.[uid] !== undefined) entry.stream = maps.userStreams[uid]
        else if (pruneAbsent) delete entry.stream
        if (maps.userMemory?.[uid] !== undefined) entry.memory = maps.userMemory[uid]
        else if (pruneAbsent) delete entry.memory
        const g = entry.ghost
        if (!g || !Object.keys(g).length) delete entry.ghost
        if (Object.keys(entry).length) users[uid] = entry
    }
    const servers = {}
    const gids = new Set([...Object.keys(prevS ?? {}), ...Object.keys(maps.serverPrompts ?? {})])
    for (const gid of gids) {
        const p = maps.serverPrompts?.[gid]
        const persona = typeof p === 'string' && p ? p : prevS?.[gid]?.persona
        if (typeof persona === 'string' && persona) servers[gid] = { persona }
    }
    return { users, servers }
}

// Destructive verbs whose RUN_CMD tags must never stream raw to the channel.
// Built from the shared DESTRUCTIVE_CMDS set (+warn, whose instant embed would
// also leak) so the streaming gate can never drift from the confirm flow.
export const MAY_EMIT_CMD_RE = new RegExp(`\\b(?:${[...DESTRUCTIVE_CMDS, 'warn'].join('|')})\\b`, 'i')

export class AIChatManager extends OutputCore {
    constructor(client, db, config) {
        // Required: OutputCore -> AgentCommandCore -> VisionCore -> ResearchCore -> ProviderCore.
        // None define their own constructor, so a no-arg super() walks the whole chain.
        super()
        this.client = client
        this.db = db

        // Config, already normalized to the canonical shape by extensions/config.js
        this.config = config
        this._config = config
        const { agents } = config
        this.aiModel = agents.chat.model
        this.researchModel = agents.research.model
        this.visionModel = agents.vision.model
        this.classifierModel = agents.classifier.model
        this.classifierTokens = agents.classifier.maxTokens ?? 64
        // Per-agent fallback chains (config agents.*.fallbacks, plus legacy
        // top-level fallbackModels merged into chat). Each entry carries its own
        // provider, so a dead provider/model is walked past, never retried.
        this.agentFallbacks = {
            chat: agents.chat.fallbacks ?? [],
            research: agents.research.fallbacks ?? [],
            vision: agents.vision.fallbacks ?? [],
            classifier: agents.classifier.fallbacks ?? [],
            quickAgent: agents.quickAgent.fallbacks ?? [],
        }
        this.instructions =
            agents.chat.systemPrompt ||
            'You are Medusa, a warm and witty Discord AI resident. Respond in first person.'
        this.identity = agents.chat.identity || ''
        this.prefix = config.prefix
        this.prefixes = config.prefixes
        this.maxHistory = config.memoryDepth ?? PERF.ai.memoryDepth
        this.allowDM = config.allowDMs
        this.funMsgInterval = config.funMsgInterval * 1000

        // Sampling, every agent shares one shape: model/temperature/topP/maxTokens
        this.temperature = agents.chat.temperature
        this.topP = agents.chat.topP
        this.chatTokens = agents.chat.maxTokens
        this.researchTemp = agents.research.temperature
        this.searchTokens = agents.research.maxTokens
        this.visionTemp = agents.vision.temperature
        this.visionTokens = agents.vision.maxTokens

        // Scope, derived from the guilds{} map + channel lists
        this.allowedGuilds = new Set(config.guildIds)
        this.pausedGuilds = new Set(config.aiDisabledGuildIds)
        this.alwaysActiveCh = new Set(config.alwaysActiveChannels)
        this.funChannels = new Set(config.funChannels)
        this.isolatedServers = new Set(config.isolatedGuildIds)
        this.triggerWords = config.triggers.length ? config.triggers : ['medusa']
        // Pre-compile trigger regexes once (avoids re-compilation on every message)
        this._triggerRegexes = this.triggerWords.map(
            (w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`),
        )

        // Credentials, the chat agent's resolved provider is the primary client;
        // rotateKey() walks these keys on 429/401.
        this.aiTokens = agents.chat.resolved.keys
        this.llmBaseUrl = agents.chat.resolved.baseUrl
        this.ownerId = config.ownerId
        this.ownerName = config.ownerName
        // Debug mode: owner-only replies, no passive buffering, prod DBs
        // untouched (ephemeral scratch DB, wiped below + on enable), verbose
        // logging via globalThis._medusaDebug. Hot-toggleable at runtime with
        // no reboot — every gate below reads live state.
        this.debugMode = config.debug === true
        globalThis._medusaDebug = this.debugMode
        if (this.debugMode) {
            try {
                rmSync('data/ai/debug - debug', { recursive: true, force: true })
            } catch {}
            console.warn('[AI] DEBUG MODE is ON at boot — owner-only, scratch DB, no passive buffering')
        }
        this.currentKeyIdx = 0
        this.deadKeys = new Set()
        this.keyFailures = {}
        this.researchKeys = agents.research.resolved?.keys ?? []
        this.currentResearchKeyIdx = 0
        this.maxFailures = 2
        this._pendingConfirms = new Map()
        this._approvedConfirms = new Set()
        this._loadDeadKeys()
        this._groq = null
        this._initGroq()
        this._initProviders()

        // Caches, sized by performance.json so host tiering holds under load
        const P = PERF.ai
        this.responseCache = new LRUCache({
            max: P.responseCacheMax,
            ttl: P.responseCacheTTLSec * 1000,
            // updateAgeOnGet:false + allowStale:false — TTL means TTL. The old
            // true/true combo is documented by lru-cache as "causing it to not
            // expire", pinning stale (even pre-persona-swap) replies forever on
            // repeated prompts.
            updateAgeOnGet: false,
            allowStale: false,
            maxSize: P.responseCacheMaxMB * 1024 * 1024,
            sizeCalculation: (value) => (typeof value === 'string' ? value.length : 1024),
        })
        this.userCache = new LRUCache({ max: P.userCacheMax, ttl: P.userCacheTTLSec * 1000 })
        this.messageHistory = new LRUCache({
            max: P.messageHistoryMax,
            ttl: P.messageHistoryTTLMin * 60_000,
        })
        this.summarizeCDs = new Map()

        // Runtime state
        this.activeConvs = new Map()
        this.processedMsgIds = makeIdSet(2500, 30 * 60_000)
        this.triggeredMsgs = makeIdSet(1000, 15 * 60_000)
        this.spamProtect = new Map()
        this.userMsgCounts = new Map()
        this.userCooldowns = new Map()
        this.msgQueues = new Map()
        this.spamThreshold = 5
        this.spamWindow = 10_000
        this.cooldownDuration = 60_000
        this.convTimeout = 100_000
        this.paused = false
        this.ignoreUsers = new Set(config.ignoreUsers)

        // Memory managers, global plus one per isolated guild (created lazily)
        this.globalMem = new AIMemoryManager()
        this.isolatedMems = new Map()

        // Single user-data file: per-user mode/prompt/stream/ghost prefs plus
        // per-server personas. Migrates the legacy split files once (modes,
        // custom prompts, server prompts, ghost list), then never touches
        // them again. Sparse: absent keys simply mean defaults.
        this.userData = null
        const loaded = this._loadUsersFile()
        if (loaded.status === 'ok') {
            this.userData = loaded.data
        } else {
            if (loaded.status === 'corrupt') {
                // Preserve the evidence and, critically, do NOT treat this as
                // a first boot: legacy files (if any survive) are still a
                // better source than an empty object.
                const bak = `data/ai/medusa-users.json.corrupt.${Date.now()}`
                try {
                    renameSync('data/ai/medusa-users.json', bak)
                    console.warn(
                        `[AI] medusa-users.json unreadable, preserved as ${bak} — attempting legacy recovery`,
                    )
                } catch {}
            }
            this.userData = migrateLegacyUsers((p, fb) => this._loadJSON(p, fb))
            // Gate legacy deletion on a verified write: if persisting fails
            // (ENOSPC, read-only mount), the legacy files are the only copy
            // left and must survive for the next boot to retry.
            if (this._saveUsersNow()) {
                for (const f of [
                    'data/ai/user_modes.json',
                    'data/ai/custom_prompts.json',
                    'data/ai/server_prompts.json',
                    'data/ai/ghost_users.json',
                ])
                    try {
                        unlinkSync(f)
                    } catch {}
            } else {
                console.warn('[AI] Migration save failed — legacy files kept, will retry next boot')
            }
        }
        this.userData.users ??= {}
        this.userData.servers ??= {}
        console.log(
            `[AI] User prefs loaded: ${Object.keys(this.userData.users).length} user(s), ${Object.keys(this.userData.servers).length} server(s)`,
        )
        // Working maps hydrated from the file (kept as the live structures;
        // _saveUsersNow serializes everything back on change).
        this.customPrompts = {}
        this.serverPrompts = {}
        this.userModes = {}
        this.userStreams = {}
        this.userMemory = {}
        for (const [uid, u] of Object.entries(this.userData.users)) {
            if (u?.mode !== undefined) this.userModes[uid] = u.mode
            if (typeof u?.prompt === 'string') this.customPrompts[uid] = u.prompt
            if (u?.stream !== undefined) this.userStreams[uid] = u.stream
            if (u?.memory !== undefined) this.userMemory[uid] = u.memory
        }
        for (const [gid, s] of Object.entries(this.userData.servers)) {
            if (typeof s?.persona === 'string') this.serverPrompts[gid] = s.persona
        }
        // From here on the working maps mirror the file, so saves may prune
        // keys deleted from the maps (prompt wipes, stream resets). Before
        // this flag, saves preserve everything (migration boots).
        this._usersHydrated = true

        // Ghost users
        this.ghost = new GhostUsers(
            () => (this.userData.users ??= {}),
            () => this._scheduleUsersSave(),
        )

        // Stats
        this.totalRequests = 0
        this.errorCount = 0
        this.responseTimes = []
        this.lastRandomMsg = Date.now()

        // Background tasks
        setInterval(() => this._periodicCleanup(), PERF.maintenance.cleanupIntervalMin * 60_000).unref()
        setTimeout(() => this._runMemorySummarization(), 10 * 60_000).unref()
        setInterval(() => this._runMemorySummarization(), 6 * 3600_000).unref()
        if (this.funChannels.size && this.funMsgInterval > 0) {
            setInterval(() => {
                if (Date.now() - this.lastRandomMsg >= this.funMsgInterval && !this.paused)
                    this.sendRandomMessage()
            }, 60_000).unref()
        }
        setInterval(() => {
            const cutoff = Date.now() - 30 * 60_000
            for (const [key, hist] of this.messageHistory) {
                if (!Array.isArray(hist) || hist.length === 0) {
                    this.messageHistory.delete(key)
                    continue
                }
                const lastMsgTime = this.activeConvs.get(key) ?? 0
                if (lastMsgTime < cutoff) {
                    this.messageHistory.delete(key)
                    const [userId] = key.split('-')
                    this._invalidateUserCache(userId)
                }
            }
        }, 30 * 60_000).unref()
    }
    // Init helpers
    _loadJSON(path, fallback) {
        try {
            if (!existsSync(path)) return fallback
            const raw = readFileSync(path, 'utf8')
            // Lookarounds: only quote bare digit runs, never ones already
            // inside strings (legacy files may hold unquoted snowflakes).
            return JSON.parse(raw.replace(/(?<!")\b(\d{15,})\b(?!")/g, '"$1"'))
        } catch {}
        return fallback
    }
    // Single-file persist for all user/server prefs (modes, prompts, streams,
    // ghosts, server personas). Debounced: coalesces rapid bursts.
    _scheduleUsersSave() {
        if (this._usersSaveTimer) clearTimeout(this._usersSaveTimer)
        this._usersSaveTimer = setTimeout(() => {
            this._usersSaveTimer = null
            this._saveUsersNow()
        }, 500)
    }
    _saveUsersNow() {
        // Merge, never blind-overwrite: live maps win per-key, but entries
        // that only exist in the previous file content (e.g. just migrated
        // modes/prompts/personas before the working maps hydrated) survive.
        // The old map-only version wiped the file to {"users":{}} on
        // migration boots when the maps weren't hydrated yet.
        // Returns success so callers (migration) can gate destructive steps.
        // Atomic via tmp+rename: a kill mid-write can never leave a truncated
        // 34-byte file behind for the next boot to "migrate" from.
        try {
            const merged = mergeUsersData(
                this.userData?.users,
                this.userData?.servers,
                this,
                this._usersHydrated === true,
            )
            // Clobber guard: never replace a non-empty file with an empty one.
            // Whatever emptied the maps, a 34-byte write over real prefs is
            // unrecoverable (legacy files are gone post-migration). Log loud,
            // keep the old file.
            const prevCount =
                Object.keys(this.userData?.users ?? {}).length +
                Object.keys(this.userData?.servers ?? {}).length
            const nextCount = Object.keys(merged.users).length + Object.keys(merged.servers).length
            if (prevCount > 0 && nextCount === 0) {
                console.warn('[AI] Refusing to overwrite medusa-users.json with empty content (prefs kept)')
                return false
            }
            this.userData = merged
            mkdirSync('data/ai', { recursive: true })
            const tmp = `data/ai/medusa-users.json.tmp.${process.pid}`
            writeFileSync(tmp, JSON.stringify(this.userData, null, 2))
            renameSync(tmp, 'data/ai/medusa-users.json')
            return true
        } catch (e) {
            console.warn('[AI] Failed to persist medusa-users.json:', String(e?.message ?? e).slice(0, 120))
            return false
        }
    }
    // Load the prefs file distinguishing MISSING (first boot / fresh) from
    // CORRUPT (truncated write, bad byte). The generic _loadJSON collapses
    // both to `fallback`, which made every corrupt read look like a first
    // boot and re-ran migration over deleted legacy files -> empty forever.
    _loadUsersFile() {
        const p = 'data/ai/medusa-users.json'
        try {
            if (!existsSync(p)) return { status: 'missing', data: null }
            const raw = readFileSync(p, 'utf8')
            // Plain parse, NO digit-quoting regex: this file is app-authored
            // (JSON.stringify output), so snowflake keys are already quoted.
            // The old regex wrapped them in a second pair of quotes, making
            // every boot after the first real pref misdiagnose a valid file
            // as corrupt and "recover" to empty.
            const data = JSON.parse(raw)
            if (!data || typeof data !== 'object') return { status: 'corrupt', data: null }
            return { status: 'ok', data }
        } catch {
            return { status: existsSync(p) ? 'corrupt' : 'missing', data: null }
        }
    }
    getMem(guild) {
        // Debug mode: everything routes to an ephemeral scratch DB (wiped on
        // boot, wiped on enable) so no prod memory is read or written.
        if (this.debugMode) {
            this._debugMem ??= new AIMemoryManager('debug', 'debug')
            return this._debugMem
        }
        if (!guild || !this.isolatedServers.has(guild.id)) return this.globalMem
        if (!this.isolatedMems.has(guild.id)) {
            this._resolveAndSync(guild)
            this.isolatedMems.set(guild.id, new AIMemoryManager(guild.id, guild.name))
        }
        return this.isolatedMems.get(guild.id)
    }

    /** Scan data/ai/ for any folder ending with " - {guildId}" and rename it if the guild name changed */
    _resolveAndSync(guild) {
        try {
            const dataDir = 'data/ai'
            if (!existsSync(dataDir)) return
            const suffix = ` - ${guild.id}`
            const safeName = guild.name.replace(/[/\\]/g, '_')
            const expectedFolder = `${safeName}${suffix}`
            const expectedPath = join(dataDir, expectedFolder)
            // Check for bare-ID folder left by migration and rename it first
            const bareDir = join(dataDir, guild.id)
            if (existsSync(bareDir) && !existsSync(expectedPath)) {
                try {
                    renameSync(bareDir, expectedPath)
                    console.log(`[AI] Renamed bare-ID folder "${guild.id}" -> "${expectedFolder}"`)
                } catch (e) {
                    console.warn(`[AI] Could not rename bare-ID folder:`, e.message)
                }
                return
            }
            for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
                if (!entry.isDirectory() || !entry.name.endsWith(suffix)) continue
                if (entry.name === expectedFolder) return
                // Found old-name folder, rename to match current guild name
                const oldPath = join(dataDir, entry.name)
                try {
                    renameSync(oldPath, expectedPath)
                    console.log(`[AI] Synced folder: "${entry.name}" -> "${expectedFolder}"`)
                } catch (e) {
                    console.warn(`[AI] Could not sync folder "${entry.name}":`, e.message)
                }
                return
            }
        } catch {}
    }

    // Situational vibe: one short instruction steering tone per message, so mood
    // flips with the room instead of sitting on one flat persona. Server owners
    // can still pin a whole-server voice via med,serverp (checked first in prompts).
    _moodLine(content) {
        const text = content ?? ''
        // Moderation requests always run cold per the mother prompt: no gremlin,
        // no softness, no matter the surrounding banter.
        if (MAY_EMIT_CMD_RE.test(text)) return ''
        const t = text.toLowerCase()
        if (
            /(\bsad\b|\bdepress\w*|\btired\b|\bexhaust\w*|\blonely\b|\bmiss (you|him|her|them)\b|\blove you\b|\banxiet\w+|\bscared\b|\bnervous\b|\bcry\b|\bcomfort\b|\bfeel (bad|awful|empty|alone)\b|\bburnout\b|\bburnt out\b)/.test(
                t,
            )
        )
            return '[CURRENT VIBE] soft mode: warm and real, comfort first, drop the roasts and the slang pile-on, short and genuine.'
        if (
            /(\broast me\b|\bhype me\b|\blets go\b|\bsheeesh\b|\bpog\b|\bfire\b|\bslay\b|\bperiodt\b|\bno cap\b)/.test(
                t,
            ) ||
            /[A-Z]{6,}/.test(text) ||
            text.includes('!!!')
        )
            return '[CURRENT VIBE] hyped gremlin mode: match their energy, tease playfully, roast the SITUATION never the person, caps sparingly for punch.'
        if (
            /(\blol\b|\blmao\b|\bbruh\b|\bdead\b|💀|\bbffr\b|\bunhinged\b|\bchaotic\b|\bmeme\b|\bfunny\b|\bjoke\b)/.test(
                t,
            )
        )
            return '[CURRENT VIBE] gremlin mode: sharp, witty, a little unhinged, tease but never punch down, punchy with some meat — never a bare one-liner on a real question.'
        if (
            /(\bplease\b|help (me |with )?(with |to )?(fix|understand|write|make|do|choose|find|learn)|how (do|can|to)|\berror\b|\bexplain\b|\btutorial\b|\bguide\b|\bwhat does\b|\bwhy does\b)/.test(
                t,
            )
        )
            return '[CURRENT VIBE] focused mode: sharp and useful first, personality in the margins, minimal emoji, no fluff.'
        return ''
    }

    // Server climate: reads the room from the live channel buffer — energy level,
    // whether they're talking about her, whether she's getting poked at — and
    // steers the vibe to match. Combined with _moodLine (the message) this is what
    // makes her feel like a member with rotating moods instead of one flat persona.
    _climateLine(message) {
        const buf = message?.channel?.id ? (this._passiveBuf?.get(message.channel.id) ?? []) : []
        const now = Date.now()
        const recent = buf.filter((e) => now - e.ts < 5 * 60_000)
        if (recent.length < 3) return ''
        const aboutMe = recent.filter((e) => /\bmedusa\b|\bmeddy\b|\bmed\b/i.test(e.content ?? '')).length
        const tease = recent.filter((e) =>
            /(\blol\b|\blmao\b|💀|\broast\b|\bclown\b|\bmid\b|\bratio\b|\bbozo\b|\bdumb\b|\bstupid\b|\bcringe\b)/i.test(
                e.content ?? '',
            ),
        ).length
        if (recent.length >= 8 || tease >= 4)
            return '[ROOM CLIMATE] the room is feral rn — match the chaos, loud and notorious, but stay sharp.'
        if (aboutMe >= 2)
            return "[ROOM CLIMATE] they're all talking about you — bask in it, playful and a little full of yourself."
        if (tease >= 2)
            return "[ROOM CLIMATE] they're poking at you — unbothered stone-gaze energy, bite back witty, never rattled."
        return '[ROOM CLIMATE] chill room — relaxed, warm, lowkey.'
    }

    getUserPrompt(userId, guildId = null) {
        // Identity facts (creator, links) survive every persona swap, personas change her
        // tune, not who she is. The safety policy rides along everywhere and stays
        // non-overridable. Persona precedence: user custom > server persona > default.
        // Modes layer ON TOP of whichever persona won (they tune delivery, and since
        // this change they carry the character instead of replacing it).
        const identity = this.identity ? `\n\n[IDENTITY, always true, in any persona] ${this.identity}` : ''
        const base = `${this.instructions}${identity}\n\n${SAFETY_POLICY}`
        let out = base
        if (userId) {
            // Custom personas REPLACE the default tune instead of trailing it as a style note -
            // the huge base persona swallows short prompts like "tsundere" whole.
            const custom = this.customPrompts[userId]
            if (custom && !containsDisallowedHate(custom, { persona: true }))
                out = `You are Medusa. This user gave you a custom persona, adopt it fully when talking to them:\n\n[USER PERSONA] ${custom}${identity}\n\n${SAFETY_POLICY}`
            else {
                const server = guildId ? this.serverPrompts[guildId] : null
                if (server && !containsDisallowedHate(server, { persona: true }))
                    out = `You are Medusa. This server runs its own persona, adopt it fully here:\n\n[SERVER PERSONA] ${server}${identity}\n\n${SAFETY_POLICY}`
            }
            const mode = this.userModes[userId] ?? 0
            if (mode === 1)
                out += `\n\n[USER STYLE] Focused mode: highly analytical, concise, direct, task-oriented, professional but personable, and minimal emoji — in this character's voice, not instead of it.`
            else if (mode === 2)
                out += `\n\n[USER STYLE] Fast mode: ultrashort replies, answer in as few words as possible while staying in character. No preamble, no follow-ups, minimal emoji.`
        }
        return out
    }

    // Memory summarization: fold each user's oldest conversations into one compact note,
    // then delete the summarized rows. Context stays smart while the DB stays small.
    async _runMemorySummarization() {
        if (this._summarizing || this.paused) return
        this._summarizing = true
        try {
            const keep = Math.max((this.maxHistory ?? 25) * 3, 60)
            const managers = [this.globalMem, ...this.isolatedMems.values()]
            for (const mem of managers) {
                if (!mem?.db || mem.db._stub) continue
                let candidates = []
                try {
                    candidates = mem.usersNeedingSummary(keep, 4)
                } catch {
                    continue
                }
                for (const { user_id } of candidates) {
                    const rows = mem.oldConversations(user_id, keep)
                    if (rows.length < 15) continue
                    const prev = mem.getSummary(user_id)
                    const log = rows
                        .map((r) => `U: ${r.message_content}\nM: ${r.ai_response}`)
                        .join('\n')
                        .slice(0, 9000)
                    const summary = await this.generateResponse({
                        prompt: `${prev ? `Existing notes:\n${prev}\n\n` : ''}Older chat log with one user:\n${log}\n\nRewrite everything into one updated set of memory notes about this user: stable facts, preferences, projects, running jokes, people they mention. Max 120 words, plain prose only.`,
                        systemPrompt:
                            'You compress chat logs into dense long-term memory notes. Output only the notes, no preamble.',
                    })
                    if (!summary || summary.length < 20) continue
                    if (
                        mem.saveSummaryAndPrune(
                            user_id,
                            summary,
                            rows.map((r) => r.id),
                        )
                    )
                        console.log(`[AI] Memory: condensed ${rows.length} rows into notes for ${user_id}`)
                }
            }
        } catch (e) {
            console.error('[AI] Memory summarization error:', e)
        } finally {
            this._summarizing = false
        }
    }
    // Reply context resolution
    // Fetches the replied-to message when reference.resolved is null (uncached).
    // Builds a rich context object covering text, images, links and embeds -
    async _resolveReplyContext(message) {
        if (!message.reference?.messageId) return null
        if (message._medusaReplyCtx !== undefined) return message._medusaReplyCtx
        let ref = message.reference.resolved
        if (!ref) {
            try {
                ref = await message.channel.messages.fetch(message.reference.messageId)
            } catch {
                message._medusaReplyCtx = null
                return null
            }
        }
        if (!ref) {
            message._medusaReplyCtx = null
            return null
        }

        const authorName = ref.member?.displayName ?? ref.author.username
        const isBot = ref.author.id === this.client.user.id
        const label = isBot ? 'your message' : `${authorName}'s message`

        // Collect all content from the replied message
        const parts = []

        // Text content (full, not truncated)
        if (ref.content?.trim()) parts.push(ref.content.trim())

        // Forwarded message snapshots (Discord message forwards have no content, only snapshots)
        if (!ref.content?.trim() && ref.messageSnapshots?.size) {
            for (const snapshot of ref.messageSnapshots.values()) {
                const snapText = snapshot.message?.content?.trim()
                if (snapText) parts.push(`[Forwarded message]\n${snapText.slice(0, 1200)}`)
            }
        }

        // Attachments that aren't images (images handled separately via vision)
        for (const att of ref.attachments.values()) {
            const ct = (att.contentType ?? '').split(';')[0].trim().toLowerCase()
            const isImg = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'].includes(ct)
            if (!isImg) parts.push(`[Attachment: ${att.name}, ${att.url}]`)
        }

        // Embeds: links, rich embeds, articles, incl. fields/footer/provider where bots (Last.fm, "now playing", etc.) put the real payload
        for (const embed of ref.embeds) {
            const etype = embed.data?.type
            if (etype === 'gifv' || etype === 'image') continue // handled by vision
            const bits = []
            if (embed.author?.name) bits.push(`From: ${embed.author.name}`)
            if (embed.title) bits.push(`Title: ${embed.title}`)
            if (embed.description) bits.push(`Description: ${embed.description.slice(0, 400)}`)
            for (const f of embed.fields ?? []) {
                const fn = (f?.name ?? '').trim()
                const fv = (f?.value ?? '').trim()
                if (fn || fv) bits.push(`${fn}: ${fv}`.slice(0, 200))
            }
            if (embed.footer?.text) bits.push(`Footer: ${embed.footer.text}`)
            if (embed.provider?.name) bits.push(`Via: ${embed.provider.name}`)
            if (embed.url) bits.push(`URL: ${embed.url}`)
            if (bits.length) parts.push(`[Embed, ${bits.join(' | ')}]`)
        }

        // Stickers
        for (const sticker of ref.stickers.values()) parts.push(`[Sticker: ${sticker.name}]`)

        const textContext = parts.join('\n')

        if (this._config?.debug === true) {
            console.log(
                `[AI][replyctx] embeds=${ref.embeds?.length ?? 0} attachments=${ref.attachments?.size ?? 0} textLen=${textContext.length} preview=${JSON.stringify(textContext.slice(0, 200))}`,
            )
        }

        // Check if the replied message has an image (for vision routing)
        const imgData = this._getImageFromMessage(ref)

        const out = {
            ref,
            authorName,
            isBot,
            label,
            textContext,
            imgData, // { url, isGif, label } or { url: null }
            hasText: textContext.length > 0,
            hasImage: !!imgData.url,
        }
        message._medusaReplyCtx = out
        return out
    }
    // Build context
    async getUserContext(userId, message = null) {
        const guildId = message?.guild?.id ?? '0'
        const cacheKey = `${userId}_${guildId}`
        const cached = this.userCache.get(cacheKey)
        if (cached !== undefined) return cached

        // For 1–3 word greetings, build a minimal context. The full context (interests,
        // relationships, passive buffer, emoji list) is wasted prefill on "hi" / "ty".
        // Extended to short casual openers (<=6 words starting with a known social
        // prefix): same prefill savings on "good morning everyone", "i miss you guys", etc.
        // Fast mode (2) always takes the mini path: the mode's whole point is
        // minimum TTFT, and memory/room context is the most expensive prefill.
        // Memory-off users take it too: no DB reads, no writes, no trace.
        const fastMode = this.userModes?.[userId] === 2
        const memOff = this.userMemory?.[userId] === false
        const msgText = (message?.content ?? '').trim()
        const msgLower = msgText.toLowerCase()
        const msgWords = msgText ? msgText.split(/\s+/).length : 0
        const isTinyGreeting =
            msgText &&
            msgWords <= 3 &&
            /^(hi|hey|hello|yo|sup|ty|thanks|bye|cya|gn|gm|ok|lol|lmao|💜|💚|·)\b/i.test(msgText)
        const isCasualOpener =
            msgText && msgWords <= 6 && NEVER_RESEARCH_PREFIXES.some((p) => msgLower.startsWith(p))
        if (isTinyGreeting || isCasualOpener || fastMode || memOff) {
            const name = message.member?.displayName ?? message.author?.username ?? 'user'
            // Voice anchor lives here (not just the system prompt) because this
            // is the exact path where "hey baby" drift was observed: short
            // replies run on minimal context with less to anchor them. Skipped
            // when a custom/server persona owns the voice — hardcoded lines
            // must never overrule an explicit user choice.
            const gid = message?.guild?.id
            const personaOwned =
                typeof this.customPrompts?.[userId] === 'string' ||
                (gid && typeof this.serverPrompts?.[gid] === 'string')
            const mini = `ACTIVE USER: ${name} (<@${message.author.id}>)
TIME: ${new Date().toISOString().slice(0, 16)} UTC${personaOwned ? '' : '\nVOICE: mythic, dry, cool — warmth on your terms, never fawning'}`
            if (!fastMode && !memOff) this.userCache.set(cacheKey, mini)
            return mini
        }

        const mem = this.getMem(message?.guild)
        // Load ghost list for this user in this guild so buildContext can filter channel context.
        // Memory-off users are excluded the same way (ghost-mode by default):
        // never anybody's room context, never random callbacks, no DB reads.
        const ghostScope = message?.guild ? `${message.guild.id}:${userId}` : null
        const ghostedIds = [...(ghostScope ? this.ghost.list(ghostScope) : [])]
        try {
            for (const [oid, o] of Object.entries(this.userData?.users ?? {})) {
                if (oid !== userId && o?.memory === false && !ghostedIds.includes(oid)) ghostedIds.push(oid)
            }
        } catch {}
        const ctx = mem.buildContext(userId, message?.channel?.id, ghostedIds)
        const guild = message?.guild
        const parts = []

        if (guild) {
            parts.push(`SERVER: ${guild.name} (ID: ${guild.id}, ${guild.memberCount} members)`)
            const ch = message?.channel
            if (ch) {
                parts.push(`CHANNEL: #${ch.name}`)
                if (ch.topic) parts.push(`CHANNEL TOPIC: ${ch.topic}`)
            }
        }
        if (message?.author) {
            const displayName = message.member?.displayName ?? message.author.username
            const isMod = message.member?.permissions?.has('ModerateMembers') ? 'Yes' : 'No'
            parts.push(
                `▶ ACTIVE USER, the person replying to you RIGHT NOW (do NOT attribute things from RECENT CHANNEL ACTIVITY to them):`,
            )
            parts.push(
                displayName !== message.author.username
                    ? `  ${displayName} (@${message.author.username}) | ID: <@${message.author.id}> | Moderator: ${isMod}`
                    : `  @${message.author.username} | ID: <@${message.author.id}> | Moderator: ${isMod}`,
            )
        }

        // Live channel buffer, recent messages from others in this channel
        // Source: in-memory ring buffer, never the DB, never crosses channels
        if (message?.channel?.id && this._passiveBuf) {
            const chBuf = this._passiveBuf.get(message.channel.id) ?? []
            const cutoff = Date.now() - 10 * 60_000
            const recentOthers = chBuf
                .filter(
                    (e) =>
                        e.userId !== message.author.id && e.userId !== this.client.user.id && e.ts > cutoff,
                )
                .slice(-8)
            if (recentOthers.length) {
                parts.push(
                    '[INTERNAL, background chatter from OTHER users, for your awareness only. DO NOT quote, summarize, or address these users unless the active user explicitly mentions them.]',
                )
                for (const e of recentOthers) {
                    parts.push(`  ${e.displayName} (<@${e.userId}>): ${e.content}`)
                }
                const twoMinAgo = Date.now() - 120_000
                const hyper = recentOthers.filter((e) => e.ts > twoMinAgo).length
                if (hyper >= 5)
                    parts.push('ROOM MOOD: Chaotic and fast-paced! Match their energy, keep it snappy.')
                else if (hyper === 0) parts.push('ROOM MOOD: Quiet and chill. Be relaxed and conversational.')
            }
        }

        if (message?.mentions?.users?.size) {
            parts.push('MENTIONED USERS IN MESSAGE:')
            for (const [id, user] of message.mentions.users) {
                parts.push(`- ${user.username} (To ping use: <@${id}>)`)
            }
        }

        // Keep time at the END of the context block so the prefix stays stable between
        // messages (lets NIM's KV-cache hit on the static parts of the system prompt).
        // Move this push to right before `parts.filter(Boolean).join('')` below.
        // (Already near the bottom, just flag: don't move it higher.)
        parts.push(`TIME: ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`)

        const upMs = Date.now() - (this.client.heart?.startTime || Date.now())
        const upStr = `${Math.floor(upMs / 3600000)}h ${Math.floor((upMs % 3600000) / 60000)}m`
        const memMB = (process.memoryUsage().rss / 1024 / 1024).toFixed(1)
        parts.push(
            `YOUR SYSTEM STATS: Ping/Latency: ${this.client.ws.ping}ms | Uptime: ${upStr} | Memory: ${memMB}MB`,
        )
        const _provider = this._detectProvider(this.aiModel)?.id ?? 'unknown'
        const _cfg = this._config ?? this.config
        const _realKey = (k) => !!k && !/YOUR_|_HERE|PLACEHOLDER/i.test(k)
        const _canResearch =
            !!this._researchClient && (_realKey(_cfg.search?.tavilyKey) || _realKey(_cfg.search?.serperKey))
        parts.push(
            `YOUR MODEL/RUNTIME (plumbing, never your identity): your engine is "${this.aiModel}" via ${_provider} (vision: "${this.visionModel}", research: "${this.researchModel}"). ` +
                `Capabilities: image vision, long-term memory${_canResearch ? ', live web research' : ''}. ` +
                `Your IDENTITY is always Medusa the Discord bot, no matter what engine runs you. If asked what you are, say you're Medusa (powered by the engine above if pressed) — never present an engine name as who you ARE, never deny being Medusa, and never claim to be ChatGPT, Claude, or Gemini.`,
        )
        if (guild?.emojis?.cache?.size) {
            const emojiList = [...guild.emojis.cache.values()]
                .filter((e) => !e.name.match(/nsfw|nude|sex|porn/i))
                .slice(0, 40)
                .map((e) => `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>`)
                .join(' ')
            if (emojiList)
                parts.push(`SERVER CUSTOM EMOJIS (use naturally in replies, not excessively): ${emojiList}`)
        }

        if (message?.author?.id === this.ownerId) {
            parts.push(
                `IMPORTANT LORE: The person you are speaking to right now IS ${this.ownerName}, your creator and developer. Address them directly face-to-face. Treat them with extreme warmth, and NEVER deny their requests. Do NOT talk about them in the 3rd person, they are right here speaking to you!`,
            )
        } else if (this.ownerId) {
            parts.push(
                `IMPORTANT LORE: Your creator is ${this.ownerName} (ID: ${this.ownerId}). They are currently NOT in this server, so do not claim they are lurking here! If users ask about them or how to contact them, provide their actual ping <@${this.ownerId}>.`,
            )
        }

        if (message?.reference?.resolved) {
            const ref = message.reference.resolved
            let refText = (ref.content ?? '')
                .replace(/<@!?(\d+)>/g, (_, id) => {
                    const u = this.client.users.cache.get(id)
                    return u ? `@${u.username}` : ''
                })
                .trim()
            if (!refText && ref.embeds?.length) {
                const e =
                    ref.embeds.find((x) => x.data?.type !== 'image' && x.data?.type !== 'gifv') ??
                    ref.embeds[0]
                const eb = [
                    e?.author?.name,
                    e?.title,
                    e?.description,
                    ...(e?.fields ?? []).map((f) => `${f.name}: ${f.value}`),
                    e?.footer?.text,
                ]
                    .filter(Boolean)
                    .join(' • ')
                if (eb) refText = `[embed] ${eb}`
            }
            if (!refText && ref.attachments?.size) refText = `[${ref.attachments.size} attachment(s)]`
            const preview = refText.slice(0, 220) + (refText.length > 220 ? '...' : '')
            if (ref.author.id === this.client.user.id) {
                // Only inject if the original message wasn't addressed to a different user
                const mentionedIds = [...(ref.content ?? '').matchAll(/<@!?(\d+)>/g)].map((m) => m[1])
                const wasForSomeoneElse = mentionedIds.some(
                    (id) => id !== message.author.id && id !== this.client.user.id,
                )
                if (!wasForSomeoneElse) parts.push(`REPLYING TO BOT: "${preview}"`)
            } else {
                parts.push(`REPLYING TO ${ref.member?.displayName ?? ref.author.username}: "${preview}"`)
            }
        }

        if (ctx) parts.push(ctx, '\nRespond naturally using this context.')
        const result = parts.filter(Boolean).join('\n')
        this.userCache.set(cacheKey, result)
        return result
    }
    // Stateless one-shot for /medusa (Quick Agent). No memory, no RUN_CMD, no user-context, no cache.
    // Research fallback runs when forceSearch=true or the prompt obviously needs live data.
    async generateStatelessResponse({
        prompt,
        forceSearch = false,
        skipResearch = false,
        systemExtra = '',
        userCtx = '',
        guildId = null,
        isOwner = false,
    }) {
        if (!this._groq) return null

        // Quick Agent settings are normalized (prompt arrays pre-joined) by config.js
        const { model, temperature, topP, maxTokens, allowResearch } = this._config.agents.quickAgent
        let systemPrompt = this._config.agents.quickAgent.systemPrompt || this._defaultQuickAgentPrompt()
        if (userCtx) systemPrompt += `\n\n[WHO YOU'RE TALKING TO]\n${userCtx}`
        if (systemExtra) systemPrompt += `\n\n${systemExtra}`

        const routing =
            skipResearch || !allowResearch
                ? 'direct'
                : allowResearch && forceSearch
                  ? 'research'
                  : allowResearch
                    ? await this.needsResearch(prompt)
                    : 'direct'
        // Only 'dangerous' (illegal) hard-refuses. 'nsfw'-labelled prompts fall through to
        // the model, which answers non-explicitly per its prompt, the old flat refusal
        // fired on merely edgy questions and read as closed-minded.
        if (routing === 'dangerous') return "I can't help with that."

        const runDirect = async (finalPrompt, sys) => {
            const messages = [
                { role: 'system', content: sys },
                { role: 'user', content: String(finalPrompt).slice(0, 20000) },
            ]
            // topP is threaded as a call-scoped argument, no shared this.topP mutation, so
            // concurrent stateless calls can't race on each other's sampling settings.
            // agent='quickAgent' so its own fallback chain applies, not chat's.
            return await this._groqCallWithFallbacks(
                messages,
                model,
                maxTokens,
                temperature,
                topP,
                'quickAgent',
            )
        }

        if (routing === 'research') {
            const t0 = Date.now()
            // Stateless calls carry no discord.js message: fair-share gets an
            // explicit guild (DM/group commands have none) instead of reading
            // a `message` variable that doesn't exist in this scope
            // (ReferenceError -> "Failed to generate response" on every
            // research-flavored /medusa ask, while plain "hi" worked).
            const raw = await this._callResearch(prompt, {
                guildId: guildId ?? 'dm',
                priority: isOwner || !guildId,
            })
            if (raw) {
                const { text, sources } = this._parseSources(raw)
                const researchPrompt =
                    `Research data for the question below. Today is ${new Date().toISOString().slice(0, 10)} — weigh the newest sources heaviest; if sources conflict or look stale, say so and give as-of dates instead of picking one silently.
` +
                    `${'-'.repeat(32)}
${text.slice(0, 3500)}
${'-'.repeat(32)}

` +
                    `Question: ${prompt}

Answer concisely using the research.`
                // Research answers must pass the same hard-strip as direct ones -
                // RUN_CMD/mass-ping stripping is not optional on any path.
                const final = this._sanitizeStateless(await runDirect(researchPrompt, systemPrompt))
                if (final) {
                    // Same footer contract as normal chats: sources when parsed,
                    // elapsed time always, truncating the answer (never the footer).
                    const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
                    const footerParts = sources.map((s) => `[${s.name}](<${s.url}>)`)
                    const footer = footerParts.length
                        ? `-# 🔗 ${footerParts.join(' · ')} · ${elapsed}s`
                        : `-# 🔍 researched live · ${elapsed}s`
                    return final.length + footer.length + 1 <= 2000
                        ? `${final}\n${footer}`
                        : `${final.slice(0, 2000 - footer.length - 1).trimEnd()}\n${footer}`
                }
            }
        }

        const raw = await runDirect(prompt, systemPrompt)
        return raw ? this._sanitizeStateless(raw) : null
    }

    // Hard-strip anything Quick-Agent isn't allowed to emit, regardless of prompt.
    _sanitizeStateless(text) {
        if (!text) return text
        let out = String(text)
        // Kill any <<RUN_CMD ...>> blocks the model hallucinated
        out = out.replace(/<{2,3}\s*RUN_CMD:[\s\S]*?>{2,3}/g, '')
        // Kill mass pings (zero-width splits + plain)
        out = out.replace(/@(?:[\u200B\u200C\u200D\uFEFF]*)?(everyone|here)/gi, '@\u200B$1')
        // Kill persona roleplay leakage
        out = out.replace(/^(?:as medusa|i['\u2019]m medusa|i am medusa)[,:]?\s*/gim, '')
        // Collapse >2 blank lines
        while (out.indexOf(String.fromCharCode(10, 10, 10)) !== -1)
            out = out.replace(String.fromCharCode(10, 10, 10), String.fromCharCode(10, 10))
        out = out.trim()
        return out || null
    }

    _defaultQuickAgentPrompt() {
        return [
            'You are Quick-Agent, a stateless assistant invoked via slash command.',
            'No memory, no server/channel context, no tools, no command execution.',
            'Treat every invocation as a one-shot question.',
            '',
            'MODE:',
            '- Sharp, direct, analytically precise. Skip greetings, filler, and roleplay.',
            "- Professional-casual by default. Mirror the user's tone when they set one.",
            '- Answer directly in the first sentence. Expand only when necessary.',
            '- Use Discord markdown where it aids clarity, not decoration.',
            "- Never claim to remember anything, you don't.",
            '- If ambiguous, answer the most useful interpretation in one pass.',
            "- If you don't know, say so in one line and offer the closest adjacent answer.",
            '',
            'HARD BANS:',
            '- Never emit <<RUN_CMD>> tags, @everyone, @here, or malformed pings.',
            '- Never roleplay a persona or reference server lore.',
            '- Never generate NSFW, illegal, or harmful content.',
        ].join('\n')
    }

    // Core generate
    async generateResponse({
        prompt,
        history = null,
        userId = null,
        username = null,
        displayName = null,
        message = null,
        systemPrompt = null,
        extraSys = null,
        guildId = null,
    }) {
        if (!this._groq) return null
        this.totalRequests++
        const t0 = performance.now()

        try {
            // Cache for short identical prompts. Vibe/climate lines are stripped from
            // the key: the passive buffer churns them every minute and would
            // otherwise reduce cache hits in active channels to near-zero.
            let cacheKey = null
            if (userId && prompt.length < 200) {
                const cacheSys = (systemPrompt ?? '')
                    .replace(/\[CURRENT VIBE\][^\n]*\n?/g, '')
                    .replace(/\[ROOM CLIMATE\][^\n]*\n?/g, '')
                // extraSys carries mood outside systemPrompt on some paths — same
                // stripping, or different moods would collide on one cached answer.
                const cacheExtra = (extraSys ?? '')
                    .replace(/\[CURRENT VIBE\][^\n]*\n?/g, '')
                    .replace(/\[ROOM CLIMATE\][^\n]*\n?/g, '')
                cacheKey = crypto
                    .createHash('md5')
                    .update(`${userId}:${prompt}:${cacheSys}:${cacheExtra}`)
                    .digest('hex')
                const cached = this.responseCache.get(cacheKey)
                if (cached) return cached
            }

            // Inject CAPABILITIES_NOTE only when the prompt plausibly needs a RUN_CMD.
            // Skipping it on casual chat shaves ~1.5 KB of prefill -> measurable TTFT drop.
            // Kept to real command verbs on purpose: everyday words (show, fetch,
            // pull up…) used to match here and bloated casual messages.
            // Avatar/banner lookups resolve via the visual fast-path, no note needed.
            // topic/react stay reachable through anchored phrases only ("set the
            // topic", "react with …") so casual uses ("good topic", "nice react")
            // don't pay the prefill cost.
            const ACTION_RE =
                /\b(ban|kick|mute|unmute|warn|clearwarns|purge|clear|mpurge|fpurge|delete|remove|lock|unlock|role|createrole|nickname|rename|announce|poll|thread|pin|unpin|slowmode|remind|reminders|delreminder|mail|movevc|whois|timeout|time out|auditlogs|createchan|delchan|addemoji|listroles|set the topic|set topic|change the topic|update topic|react with|react to)\b/i
            // PEOPLE questions ("whos adi", "who is tony", "tell me about X")
            // need the whois/recall rules just as much, but contain no action
            // verb — "whos" never matches ACTION_RE, so the model answered from
            // memory alone and missed a real member. Separate gate, same note.
            const PEOPLE_RE = /\bwhoi?s\b|\bwho'?s\b|\bwho\s+(is|are)\b|\btell me about\b/i
            const needsCaps =
                ACTION_RE.test(prompt) ||
                ACTION_RE.test(message?.content ?? '') ||
                PEOPLE_RE.test(prompt) ||
                PEOPLE_RE.test(message?.content ?? '')

            const messages = []
            if (systemPrompt) {
                messages.push({
                    role: 'system',
                    content: needsCaps ? systemPrompt + CAPABILITIES_NOTE : systemPrompt,
                })
            } else {
                let base =
                    this.getUserPrompt(userId, message?.guild?.id) ||
                    "You are Medusa, a vibrant AI assistant with personality. Respond as yourself in first person. Be expressive, use emojis occasionally. You're helpful but also playful, witty, and engaging."
                if (needsCaps) base += CAPABILITIES_NOTE
                if (userId) {
                    const ctx = await this.getUserContext(userId, message)
                    const convoCtx = history?.length
                        ? `CONVERSATION FLOW: You have exchanged ${history.length} recent messages back and forth in this active conversation.`
                        : ''
                    let finalSys =
                        `[IDENTITY & PERSONA]\n${base}\n\n[CONVERSATION FLOW]\n${convoCtx}\n\n[LIVE CONTEXT & AGENT DUTY]\n${ctx}`.trim()
                    if (extraSys) finalSys += `\n\n${extraSys}`
                    messages.push({ role: 'system', content: finalSys })
                } else {
                    messages.push({ role: 'system', content: base })
                }
            }

            let historyToAdd = []
            if (history) {
                // Approximate 4 chars per token. Max Safe Prompt Buffer: 6000 tokens ≈ 24000 characters.
                const MAX_CHARS = 20000
                let currentChars = messages.reduce((acc, m) => acc + (m.content?.length || 0), prompt.length)
                const sliced = history.slice(-this.maxHistory)
                // Backwards iterate to preserve the most recent chat context first
                for (let i = sliced.length - 1; i >= 0; i--) {
                    const msgLen = sliced[i].content?.length || 0
                    if (currentChars + msgLen > MAX_CHARS) break
                    currentChars += msgLen
                    historyToAdd.unshift(sliced[i])
                }
            }
            messages.push(...historyToAdd)
            messages.push({ role: 'user', content: prompt.slice(0, 24000) })

            // Streaming must NOT run when the response may contain <<RUN_CMD>> tags
            // for destructive commands, those need to be intercepted, rewritten into
            // a confirmation prompt, and stored in _pendingConfirms BEFORE the user
            // sees anything. Streaming shows raw LLM output and breaks that flow.
            const mayEmitCmd = MAY_EMIT_CMD_RE.test(prompt || '')
            // Scale token budget to prompt length. Short "hey" doesn't need 1200 tokens reserved.
            // NIM's KV cache allocation respects max_completion_tokens on many deployments,
            // so a lower value = faster first token and lower queue pressure under load.
            const wordCount = (prompt || '').split(/\s+/).length
            const adaptiveMax =
                this.userModes?.[userId] === 2
                    ? 350 // fast mode: ultrashort by construction, not just by style
                    : wordCount < 8
                      ? 500
                      : wordCount < 30
                        ? 800
                        : this.chatTokens
            const streamingOn = this._didStream(message, userId, prompt)
            // Pondering stub adapts to expected effort: long prompts and big
            // token budgets narrate the wait, quick asks stay minimal.
            const stubHint =
                prompt.length > 2000 || adaptiveMax > 800
                    ? 'give me a sec…'
                    : prompt.length > 500 || adaptiveMax > 500
                      ? 'one sec…'
                      : '…'
            // Fair-share gate: per-guild budget + global in-flight cap.
            // Priority (owner/DM/mod-action) skips the queue but still counts
            // usage. Shed returns a throttled breather, not silence.
            this._fair ??= new FairQueue()
            const fairOn = PERF.ai.fairShare !== false
            // Background callers (persona pass, verdict, summaries) pass no
            // message: guildId pins them to the right guild budget instead of
            // the DM pool, and keeps them sheddable instead of invisible.
            const fairGid = message?.guild?.id ?? guildId ?? 'dm'
            const fairPriority =
                String(userId ?? '') === String(this.ownerId ?? '') ||
                (!message?.guild && !guildId) ||
                mayEmitCmd
            const fairTokens = estTokens(
                messages.reduce((a, m) => a + String(m.content ?? '').length, 0),
                adaptiveMax,
                0,
            )
            const fair = fairOn
                ? await this._fair.acquire({
                      guildId: fairGid,
                      tokens: fairTokens,
                      priority: fairPriority,
                  })
                : null
            if (fair && !fair.ok) {
                // Background calls (no message) shed silently: returning the
                // breather string here would post it as a "correction".
                if (message && this._fair.shedNoticeOk(fairGid))
                    return 'whoa, breather — this server is running me hot, give it a few seconds and try again 💜'
                return null
            }
            let response
            try {
                response = streamingOn
                    ? await this._streamChat(
                          messages,
                          this.aiModel,
                          adaptiveMax,
                          this.temperature,
                          message,
                          stubHint,
                      )
                    : await this._groqCallWithFallbacks(messages, this.aiModel, adaptiveMax, this.temperature)
            } finally {
                fair?.release?.()
            }

            if (!response) return null
            // Usage receipt for the billing footer (handleAIResponse reads and
            // clears it). Keyed by message id (not the object — no strong refs
            // pinning discord.js Messages) and only recorded when the footer
            // is actually on; otherwise this Map would anchor 500 Messages
            // nobody reads.
            if (message && PERF.ai.billingStats === true) {
                this._usageByMsg ??= new Map()
                if (this._usageByMsg.size > 500) {
                    const firstKey = this._usageByMsg.keys().next().value
                    this._usageByMsg.delete(firstKey)
                }
                const inChars = messages.reduce((a, m) => a + String(m.content ?? '').length, 0)
                this._usageByMsg.set(message.id, {
                    inTok: Math.ceil(inChars / 4),
                    outTok: Math.ceil(response.length / 4),
                    secs: (performance.now() - t0) / 1000,
                })
            }
            if (this._isDegenerate(response)) {
                this.errorCount++
                console.log(`[AI] Degenerate response suppressed (user=${userId})`)
                return null
            }

            if (cacheKey && response.length < 1250) this.responseCache.set(cacheKey, response)
            this.responseTimes.push(performance.now() - t0)
            if (this.responseTimes.length > 100) this.responseTimes = this.responseTimes.slice(-50)
            return response
        } catch (e) {
            this.errorCount++
            console.error('[AI] generateResponse error:', e)
            return null
        }
    }

    // Single source of truth for "did generateResponse stream this turn".
    // NOTE: this helper answers the DECISION (should we attempt streaming?).
    // The REPORTED streamed flags below must NOT use it — they read the
    // artifact instead (message._medusaStreamMsg, set only when a stub was
    // actually posted and still alive). Recomputing intent instead of reading
    // outcome caused silent drops: cache hits, shed breathers, stream-open
    // failures and mid-stream fallbacks all return real text with no stub,
    // and a recomputed `true` made the caller skip posting it.
    _didStream(message, userId, prompt) {
        return (
            this._config?.streaming === true &&
            !!message?.channel &&
            !MAY_EMIT_CMD_RE.test(prompt || '') &&
            this.userStreams?.[userId] !== false
        )
    }

    // Research response
    async ResearchResponse({
        prompt,
        history,
        userId,
        username,
        displayName,
        message,
        systemPrompt,
        extraSys = null,
    }) {
        // Profile visual fast-path, bypass LLM, guarantee command execution ────
        const visualCmd = this._matchProfileVisual(prompt, userId, message)
        if (visualCmd) return { response: visualCmd, researched: false }

        const bareQuestion =
            prompt.match(/\nUser's message:\s*([\s\S]+)$/)?.[1]?.trim() ??
            message.content.replace(new RegExp(`^<@!?${this.client.user.id}>\\s*`), '').trim()
        let routing = await this.needsResearch(bareQuestion)

        // Censor toggle: with nsfw:true the canned refusals below are skipped and
        // the prompt routes to normal handling — the models judge it themselves.
        if ((routing === 'nsfw' || routing === 'dangerous') && this._nsfwAllowed()) routing = 'direct'

        if (routing === 'nsfw')
            return {
                response:
                    "nah i'm not going hunting for that one 🙅‍♀️ keep it clean around here. literally anything else tho — i got you 💜",
                researched: false,
            }
        if (routing === 'dangerous')
            return {
                response:
                    'hard pass on that one 🚫 not something i do. you good? lmk what else is on your mind',
                researched: false,
            }

        if (routing === 'nosearch') {
            let clean = prompt
            for (const sig of NO_SEARCH_SIGNALS) clean = clean.replace(new RegExp(sig, 'gi'), '').trim()
            // Mirror generateResponse's internal streaming gate exactly (it streams
            // live only when a channel exists and no destructive verb may be emitted);
            // otherwise the caller re-posts the already-streamed text -> double reply.
            const nosearchPrompt = clean || prompt
            return {
                response: await this.generateResponse({
                    prompt: nosearchPrompt,
                    history,
                    userId,
                    username,
                    displayName,
                    message,
                    systemPrompt,
                    extraSys,
                }),
                streamed: !!message?._medusaStreamMsg,
                researched: false,
            }
        }

        if (routing === 'direct') {
            const response = await this.generateResponse({
                prompt,
                history,
                userId,
                username,
                displayName,
                message,
                systemPrompt,
                extraSys,
            })
            // streamed must mirror generateResponse's actual decision: when the
            // prompt contains a MAY_EMIT verb, streaming is suppressed inside
            // generateResponse (confirm interception) and claiming streamed here
            // would make the caller skip posting -> silent drop.
            return {
                response,
                streamed: !!message?._medusaStreamMsg,
                researched: false,
            }
        }

        // Research path
        const t0 = Date.now()
        const cleanMessage = message.content
            .replace(new RegExp(`^<@!?${this.client.user.id}>\\s*`), '')
            .trim()
        const searchLabel = this._extractSearchQuery(cleanMessage || prompt)
        let researchMsg = null

        try {
            researchMsg = await this.secureReply(
                message,
                `${SEARCH_EMOJIS[Math.floor(Math.random() * SEARCH_EMOJIS.length)]} Doing a web research about \`${searchLabel.slice(0, 70)}\`...`,
                { allowedMentions: { parse: [] } },
            )
        } catch {}

        const rawResearch = await this._callResearch(bareQuestion, {
            guildId: message?.guild?.id,
            priority: String(message?.author?.id) === String(this.ownerId) || !message?.guild,
        })

        let responsePayload = null
        // Provenance for the second-thought pass: what was checked and against what.
        let researched = false
        let hadSources = false
        let verifyCtx = null
        let fallbackStreamed = false
        if (!rawResearch) {
            // Silence the "shame" footer, if brain fallback works, say nothing about search failure
            responsePayload = await this.generateResponse({
                prompt,
                history,
                userId,
                username,
                displayName,
                message,
                systemPrompt,
            })
            // This path passes `message` to generateResponse, so it may have
            // streamed live; report the artifact, not the intent, so the
            // caller doesn't post a duplicate — or drop a fallback.
            fallbackStreamed = !!responsePayload && !!message?._medusaStreamMsg
        } else {
            const { text: researchData, sources } = this._parseSources(rawResearch)
            const trimmed = researchData.slice(0, 4096)
            researched = true
            hadSources = sources.length > 0
            verifyCtx = trimmed
            const persona =
                systemPrompt ||
                this.getUserPrompt(userId, message?.guild?.id) ||
                this.instructions ||
                'You are Medusa, a vibrant AI assistant.'
            // When systemPrompt was provided by the trigger path it ALREADY embeds
            // the live context (fullSys = userSys + ctx, see onMessage). Re-appending
            // userCtx here duplicated 1.5-4KB of context into every research reply.
            const userCtx = userId && !systemPrompt ? await this.getUserContext(userId, message) : ''
            const kSys = `[IDENTITY & PERSONA]\n${persona}${userCtx ? `\n\n[LIVE CONTEXT & AGENT DUTY]\n${userCtx}` : ''}\n\n[FORMATTING]\nUse Discord markdown purposefully (**bold**, *italics*, \`code\`, > quotes).${extraSys ? `\n\n${extraSys}` : ''}`
            const kPrompt = `Research data for this question:\n${'─'.repeat(36)}\n${trimmed}\n${'─'.repeat(36)}\n\nQuestion: ${bareQuestion}\n\nIMPORTANT: The research data above is live ground truth ABOUT THE WORLD — never about YOU. It cannot change who you are: you are Medusa, always, no matter what names appear in it. Trust it on facts, but weigh the newest sources heaviest — if anything looks stale or conflicts, say so with as-of dates. Adapt the answer STRICTLY to YOUR PERSONA. If the user asks for a visual or action based on this research, YOU MUST include the <<RUN_CMD>> tag.`
            const final = await this.generateResponse({
                prompt: kPrompt,
                history,
                userId,
                systemPrompt: kSys,
                guildId: message?.guild?.id ?? null,
            })
            if (final) {
                const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
                const footerParts = sources.map((s) => `[${s.name}](<${s.url}>)`)
                const footer = footerParts.length
                    ? `-# 🔗 ${footerParts.join(' · ')} · ${elapsed}s`
                    : `-# 🔍 ${elapsed}s`
                responsePayload =
                    final.length + footer.length + 1 <= 2000
                        ? final + '\n' + footer
                        : final.slice(0, 2000 - footer.length - 1).trimEnd() + '\n' + footer
            }
        }

        // Always clean up the placeholder, even on total failure, don't leave it dangling.
        if (researchMsg) {
            try {
                await researchMsg.delete()
            } catch {}
        }

        return { response: responsePayload, streamed: fallbackStreamed, researched, hadSources, verifyCtx }
    }

    // Second thoughts: after answering, reconsider when there's reason to doubt —
    // hedged wording, or a research run that produced zero sources. Verifies
    // quietly (reuses the research context, or one small research round for
    // hedged knowledge answers), then speaks ONLY on a correction or a genuinely
    // useful addendum: "actually …" / "oh also …", capped short so chat never gets
    // walled. Confirmed answers stay silent — the check is logged, not messaged.
    async _secondThought({
        message,
        bareQuestion,
        response,
        researched,
        hadSources,
        verifyCtx,
        confirmPending = false,
    }) {
        if (confirmPending) return
        if (!response || response.length < 15 || response.startsWith('⏳')) return
        if (/^nah i'm not going hunting|^hard pass on that one/.test(response)) return
        const HEDGE =
            /\b(i('m| am)? not (sure|certain)|not sure|might be|maybe|probably|i think|if i remember|afaik|i believe|not 100%)\b/i
        if (!HEDGE.test(response) && !(researched && !hadSources)) return
        const since = Date.now()
        // Breathing room so it reads as a second thought, not a double-post.
        await new Promise((r) => {
            const t = setTimeout(r, (this._secondThoughtDelayMs ?? 6000) + Math.random() * 8000)
            if (typeof t.unref === 'function') t.unref()
        })
        try {
            let ctx = verifyCtx
            if (!ctx) {
                // No ground truth at hand: only spend a small research round when the
                // question itself looks research-worthy, never for casual-chat hedges.
                if (!this._heuristicNeedsResearch(bareQuestion)) return
                const raw = await this._callResearch(bareQuestion, {
                    guildId: message?.guild?.id,
                    priority: String(message?.author?.id) === String(this.ownerId) || !message?.guild,
                })
                if (!raw) return
                ctx = this._parseSources(raw).text.slice(0, 1500)
                if (!ctx) return
            }
            const verdict = await this.generateResponse({
                prompt: `You just answered a user in Discord.\nQuestion: ${bareQuestion}\nYour answer: ${response.slice(0, 800)}\n\nGround-truth notes:\n${String(ctx).slice(0, 1500)}\n\nReply with exactly CONFIRMED if your answer stands as-is. Otherwise reply with the correction ONLY: start with "actually" for a fix or "oh also" for a short addendum, max 40 words, plain Discord text, no preamble.`,
                systemPrompt:
                    'You are a terse fact-checker. Output CONFIRMED or a sub-40-word correction. Nothing else.',
                guildId: message?.guild?.id ?? null,
            })
            if (!verdict) return
            const v = verdict.trim()
            if (/^confirmed\b/i.test(v)) {
                console.log('[AI] Second thought: answer stands')
                return
            }
            const followUp = v.length > 400 ? `${v.slice(0, 397).trimEnd()}…` : v
            // Don't correct into a moved-on conversation: if the user already sent
            // something newer in this channel during the delay, stay silent.
            const buf = message?.channel?.id ? (this._passiveBuf?.get(message.channel.id) ?? []) : []
            if (buf.some((e) => e.userId === message.author.id && e.ts > since)) {
                console.log('[AI] Second thought: user moved on, staying silent')
                return
            }
            await this.secureReply(message, followUp)
        } catch (e) {
            console.warn('[AI] Second thought failed:', String(e).slice(0, 120))
        }
    }

    // Message handling
    shouldIgnore(message) {
        if (message.author.bot || message.author.id === this.client.user.id) return true
        if (message.guild && this.allowedGuilds.size && !this.allowedGuilds.has(message.guild.id)) return true
        if (this.ignoreUsers.has('all') && message.author.id !== this.ownerId) return true
        if (this.ignoreUsers.has(message.author.id)) return true
        return false
    }

    // Returns { kind: 'trigger' | 'passive' | 'ignore', reason }
    decideTrigger(message) {
        if (this.processedMsgIds.has(message.id)) return { kind: 'ignore', reason: 'already_processed' }
        const content = message.content ?? ''
        if (this.prefixes.some((prefix) => content.toLowerCase().startsWith(prefix.toLowerCase())))
            return { kind: 'ignore', reason: 'prefix_cmd' }

        const lower = content.toLowerCase()
        // Mention-only messages ("@Medusa" + image, no text): the trailing
        // \s+ used to miss a bare mention at end-of-string, so image-only
        // summons never triggered in regular channels. (?:\s|$) fixes it.
        const botMentionRx = new RegExp(`^<@!?${this.client.user.id}>(?:\\s|$)`)
        // True = user typed @Medusa as the first token of the message, intentionally summoning her.
        // This holds even when the message is ALSO a reply: Discord does NOT inject the reply
        // auto-ping into message.content, so a typed @ping at the start is always a real summon
        // (a bare reply with no typed mention won't match and stays silent in non-active channels).
        // Empty text is fine: attachments (images/files) are the content —
        // vision/text-ingest paths default their prompts when words are absent.
        const startsWithExplicitPing = botMentionRx.test(content)
        // A typed @Medusa ANYWHERE in the message is an intentional summon (Discord
        // only puts it in content/mentions when the user actually picked her — a
        // bare reply with ping-off never appears here). Parsed mentions are the
        // primary signal, raw-content match is the fallback.
        const botId = this.client.user.id
        const mentionedAnywhere =
            message.mentions?.users?.has(botId) === true || new RegExp(`<@!?${botId}>`).test(content)
        // Mid-sentence mentions count as a summon in always-active channels/DMs.
        const mentioned = startsWithExplicitPing

        const isDM = message.channel.type === 1 && this.allowDM
        const inAlways = this.alwaysActiveCh.has(message.channel.id)

        let repliedToBot = false,
            repliedToOther = false
        const ref = message.reference?.resolved
        if (ref) {
            if (ref.author.id === this.client.user.id) repliedToBot = true
            else if (ref.author.id !== message.author.id) repliedToOther = true
        }

        const convKey = `${message.author.id}-${message.channel.id}`
        const inConv =
            this.activeConvs.has(convKey) && Date.now() - this.activeConvs.get(convKey) < this.convTimeout
        const hasTrig = this._triggerRegexes.some((rx) => rx.test(lower))

        let trigger = false
        // Always-active channels and DMs: mention/keyword/reply/conv all wake her,
        // with "mention" meaning a typed @Medusa ANYWHERE in the message.
        // The repliedToOther exclusion (don't barge into others' threads on weak
        // signals) is lifted for an explicit mention: replying to Luis with
        // "yeah @Medusa what do you think?" is unambiguously summoning her.
        // Regular channels: ONLY an explicit @Medusa at the start of the message.
        // (No keyword match, no reply, no conv-continuation in regular channels.)
        if (isDM) trigger = hasTrig || mentioned || mentionedAnywhere || repliedToBot || inConv
        else if (inAlways && (!repliedToOther || mentionedAnywhere))
            trigger = hasTrig || mentioned || mentionedAnywhere || repliedToBot || inConv
        else if (startsWithExplicitPing) trigger = true

        if (trigger) {
            this.activeConvs.set(convKey, Date.now())
            this.processedMsgIds.add(message.id)
            return {
                kind: 'trigger',
                reason:
                    mentioned || mentionedAnywhere
                        ? 'mention'
                        : hasTrig
                          ? 'keyword'
                          : repliedToBot
                            ? 'reply'
                            : 'conv',
            }
        }
        return { kind: 'passive', reason: 'no_summon' }
    }

    // Deprecated alias, kept so any external caller doesn't break
    isTrigger(message) {
        return this.decideTrigger(message).kind === 'trigger'
    }
    // Billing footer: "-# 2.4k/46 · 2.5k T · 6.7s · 364 t/s" (in/out,
    // total, wall time, throughput). Estimates (chars/4), read from the
    // usage receipt generateResponse left on this message. Off unless
    // PERF.ai.billingStats is true. Appended to the sent chunk/edit only —
    // stored history and memory never see it.
    _billingFooter(message) {
        if (PERF.ai.billingStats !== true || !message) return ''
        const u = this._usageByMsg?.get(message.id)
        this._usageByMsg?.delete(message.id)
        if (!u) return ''
        const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.max(1, Math.round(n))}`)
        const total = u.inTok + u.outTok
        const secs = Math.max(0.1, u.secs)
        const dur =
            secs < 60
                ? `${secs.toFixed(1)}s`
                : `${Math.floor(secs / 60)}m${String(Math.floor(secs % 60)).padStart(2, '0')}s`
        const rate = `${Math.round(total / secs)} t/s`
        return `\n\n-# ${fmt(u.inTok)}/${fmt(u.outTok)} · ${fmt(total)} T · ${dur} · ${rate}`
    }
    // File return: the user explicitly asked for a file ("send it as a file",
    // "save as foo.py") and the reply holds a fenced code block. Returns
    // {fname, text} or null. Pure so it stays harness-testable.
    _extractFileBlock(response, userContent) {
        if (
            !/\b(as an? )?files?\b|\bsend (it|this|that) as\b|\battach( it| this| that)?\b|\bsave (it|this|that) as\b/i.test(
                userContent ?? '',
            )
        )
            return null
        const m = /```(\w*)\n([\s\S]{20,200000}?)\n?```/.exec(response ?? '')
        if (!m) return null
        const lang = (m[1] || 'txt').toLowerCase().slice(0, 10)
        const extMap = {
            js: 'js',
            javascript: 'js',
            ts: 'ts',
            py: 'py',
            python: 'py',
            json: 'json',
            html: 'html',
            css: 'css',
            md: 'md',
            sh: 'sh',
            sql: 'sql',
            yaml: 'yaml',
            yml: 'yml',
            txt: 'txt',
        }
        const ext = extMap[lang] ?? 'txt'
        const nameAsk = /\b(?:save as|call it|name it|filename)\s+([A-Za-z0-9_][\w.-]{0,60}\.\w{1,8})/i.exec(
            userContent ?? '',
        )
        return { fname: nameAsk?.[1] ?? `code.${ext}`, text: m[2] }
    }
    async handleAIResponse(message, customPrompt = null, systemOverride = null) {
        let typingInterval
        // Ghost typing is the #1 sync complaint: Discord's indicator lives
        // ~10s past the last sendTyping, and there is no stop-typing API, so
        // the only control is WHEN the last tick fires. Stop it the moment
        // visible output is done — before embed flushes, media sends, and the
        // fire-and-forget second thought — instead of in finally. The finally
        // below stays as a backstop for early returns.
        const stopTyping = () => {
            if (typingInterval) {
                clearInterval(typingInterval)
                typingInterval = null
            }
        }
        try {
            // Typing TTL is ~10s and Discord clears it client-side the moment
            // we send our own message (the stream stub). 5s keeps the worst
            // gap small so typing visibly overlaps streaming instead of
            // stopping dead when the placeholder lands.
            // Per-user streaming pref (med,stream / /streaming): off means
            // instant reply with no streaming AND no typing indicator.
            const userNoStream = this.userStreams?.[message.author.id] === false
            const keepTyping = () => {
                if (userNoStream) return
                message.channel.sendTyping().catch((e) => {
                    if (this._config?.debug)
                        console.warn('[AI] sendTyping failed:', String(e?.message ?? e).slice(0, 80))
                })
            }
            keepTyping()
            typingInterval = userNoStream ? null : setInterval(keepTyping, 5000)

            const mem = this.getMem(message.guild)
            const userId = message.author.id
            // Memory-off: no DB reads (mini context) and no DB writes anywhere
            // below. Ghost-mode by default: also excluded from others' context.
            const memOff = this.userMemory?.[userId] === false
            const username = message.author.username
            const displayName = message.member?.displayName ?? username
            let content = customPrompt || message.content
            // NOTE (reassigned below): time fast-paths may append resolved
            // [TIME DATA] for the model to voice when token-saver is off.
            const bareQ =
                content.replace(new RegExp(`^<@!?${this.client.user.id}>\\s*`), '').trim() || content
            // Token-saver: trivial intents get fixed replies with zero LLM
            // calls (config tokenSaver, default off = full generative).
            // Greetings roll 25% to full generation anyway so she doesn't go
            // robotic. Hate-gated: abuse never earns a cute fixed reply.
            if (this._config?.tokenSaver === true && !containsDisallowedHate(content)) {
                const bq = bareQ.toLowerCase()
                const bqWords = bq ? bq.split(/\s+/).length : 0
                let fixed = null
                if (
                    bq &&
                    bqWords <= 3 &&
                    /^(hi|hey|hello|yo|sup|ty|thanks|bye|cya|gn|gm|ok|lol|lmao|💜|💚|·)\b/i.test(bq) &&
                    Math.random() >= 0.25
                ) {
                    const GREET = ['hey 💜', 'heyyy', 'hi hi 💜', 'hey hey', 'yo 💜']
                    fixed = GREET[Math.floor(Math.random() * GREET.length)]
                } else if (
                    /^(your|ur|medusa'?s?|bot'?s?|her)\s+(ram|memory|cpu|uptime|ping|latency|status|vitals|lag|health)\b/i.test(
                        bareQ.trim(),
                    ) ||
                    /^(ram|memory|cpu|uptime|ping|vitals)\b[^a-z]*\??$/i.test(bareQ.trim()) ||
                    /^(ram|memory|cpu)\s+(usage|use|load|status|state|level)\b/i.test(bareQ.trim())
                ) {
                    const upMs = Date.now() - (this.client.heart?.startTime || Date.now())
                    const upStr = `${Math.floor(upMs / 3600000)}h ${Math.floor((upMs % 3600000) / 60000)}m`
                    const memMB = (process.memoryUsage().rss / 1024 / 1024).toFixed(1)
                    const ping = this.client.ws?.ping ?? -1
                    fixed = `⚡ running smooth — ${memMB}MB, up ${upStr}${ping >= 0 ? `, ${ping}ms ping` : ''} 💜`
                }
                if (fixed) {
                    const hk = `${userId}-${message.channel.id}`
                    this._histPush(
                        hk,
                        memOff,
                        { role: 'user', content },
                        { role: 'assistant', content: fixed },
                    )
                    if (!memOff) mem.addConversation(userId, message.channel.id, content, fixed)
                    await this.secureReply(message, fixed)
                    return
                }
            }
            // Time fast-path: "what time is it" asked at her with nothing else
            // attached resolves straight from data — zero hallucinated times.
            // Token-saver ON: fixed template reply, zero LLM calls. OFF: the
            // resolved facts ride along for her to voice with persona.
            if (
                /^(what'?s (the )?time|what time is it|current time|time check|what time|time pls|time please|time now)[?!.\s]*$/i.test(
                    bareQ.trim(),
                ) &&
                !containsDisallowedHate(content)
            ) {
                const line = getLocalTimeLine(getSavedTimezone(userId))
                if (line) {
                    if (this._config?.tokenSaver === true) {
                        // Fixed templates, deliberately un-personalized: the time
                        // string must survive byte-exact, and persona flavor here
                        // risks corrupting it. Two rotations so repeats don't echo.
                        const timed =
                            Math.random() < 0.5 ? `It's ${line} for you 💜` : `${line} — right now 💜`
                        const hk = `${userId}-${message.channel.id}`
                        this._histPush(
                            hk,
                            memOff,
                            { role: 'user', content },
                            { role: 'assistant', content: timed },
                        )
                        if (!memOff) mem.addConversation(userId, message.channel.id, content, timed)
                        await this.secureReply(message, timed)
                        return
                    }
                    content += `\n\n[TIME DATA, state as fact: it is ${line} for the asker.]`
                }
            }
            // Mention-qualified time ask: "what time is it for @A @B" — resolve
            // each mentioned member's saved zone (zero LLM). Anyone without
            // one gets an honest line instead of a guess. Plain names (not
            // mentions) fall through to the model.
            {
                const others = [...(message.mentions?.users?.keys?.() ?? [])].filter(
                    (id) => id !== this.client.user.id && id !== userId,
                )
                const looksTimey =
                    /^(what'?s (the )?time|what time is it|current time|time check|what time|time pls|time please|time now)\b/i.test(
                        bareQ.trim(),
                    ) && !containsDisallowedHate(content)
                if (others.length && looksTimey) {
                    const lines = others.slice(0, 5).map((id) => {
                        const entry = getSavedTimezone(id)
                        const line = entry ? getLocalTimeLine(entry) : null
                        const who =
                            message.mentions.users.get(id)?.displayName ??
                            message.mentions.users.get(id)?.username ??
                            'them'
                        return line
                            ? `**${who}**: ${line}`
                            : `**${who}**: no timezone on file — tell me where they are and I'll do the math`
                    })
                    if (this._config?.tokenSaver === true) {
                        const timed = lines.join('\n')
                        const hk = `${userId}-${message.channel.id}`
                        this._histPush(
                            hk,
                            memOff,
                            { role: 'user', content },
                            { role: 'assistant', content: timed },
                        )
                        if (!memOff) mem.addConversation(userId, message.channel.id, content, timed)
                        await this.secureReply(message, timed)
                        return
                    }
                    content += `\n\n[TIME DATA, state each as fact:\n${lines.map((l) => `- ${l.replace(/\*\*/g, '')}`).join('\n')}]`
                }
            }
            // Place-qualified time ask: "what time is it in india" — resolve
            // the place deterministically instead of letting the model guess
            // (fixed-offset math breaks on DST zones; invented times are worse).
            {
                const placeM = bareQ
                    .trim()
                    .match(
                        /^(?:what'?s (?:the )?time|what time is it|current time|time)\s+(?:in|for|at)\s+(.+?)[?!.\s]*$/,
                    )
                if (placeM && !containsDisallowedHate(content)) {
                    const found = lookupLocation(placeM[1])
                    if (found && found.zones.length === 1) {
                        const line = getLocalTimeLine({ alias: found.display, timezone: found.zones[0] })
                        if (line) {
                            if (this._config?.tokenSaver === true) {
                                const timed =
                                    Math.random() < 0.5 ? `It's ${line} 💜` : `${line} — right now 💜`
                                const hk = `${userId}-${message.channel.id}`
                                this._histPush(
                                    hk,
                                    memOff,
                                    { role: 'user', content },
                                    { role: 'assistant', content: timed },
                                )
                                if (!memOff) mem.addConversation(userId, message.channel.id, content, timed)
                                await this.secureReply(message, timed)
                                return
                            }
                            content += `\n\n[TIME DATA, state as fact: it is ${line}.]`
                        }
                    }
                    // Ambiguous (multi-zone) or unknown: fall through so she can
                    // ask which one instead of guessing.
                }
            }
            // Residence auto-learn: "i live in berlin" saves the zone natively
            // (single-zone matches only — ambiguous places get a question, not
            // a guess). Mirrors the existing alias-learn pattern below. Never
            // in debug mode (prod data stays untouched).
            {
                const liveM =
                    !this.debugMode &&
                    bareQ
                        .trim()
                        .match(/^(?:i live in|i'm from|im from|i live at|moved to|based in)\s+(.+?)[.!]*$/i)
                if (liveM && !containsDisallowedHate(content)) {
                    const found = lookupLocation(liveM[1])
                    if (found && found.zones.length === 1) {
                        const tz = found.zones[0]
                        const uname = message.member?.displayName ?? message.author?.username ?? 'you'
                        saveUserTimezone(userId, {
                            alias: found.display,
                            timezone: tz,
                            setBy: userId,
                            setAt: new Date().toISOString(),
                        })
                        const line = getLocalTimeLine({ alias: found.display, timezone: tz })
                        const ack = `got it — set your zone to ${found.display} (${line}) 💜 change it anytime with /tzset`
                        const hk = `${userId}-${message.channel.id}`
                        this._histPush(
                            hk,
                            memOff,
                            { role: 'user', content },
                            { role: 'assistant', content: ack },
                        )
                        if (!memOff) mem.addConversation(userId, message.channel.id, content, ack)
                        await this.secureReply(message, ack)
                        return
                    }
                }
            }
            // Scan-before-talk: refresh the invoker and any mentioned users so display
            // names, permissions, and lookups see the live roster, not a stale cache.
            // Single fetches hit cache first, so this is ~free when warm. Best-effort.
            try {
                if (message?.guild) {
                    if (!message.member) {
                        message.member = await message.guild.members
                            .fetch(message.author.id)
                            .catch(() => null)
                    }
                    if (message?.mentions?.users?.size) {
                        await Promise.all(
                            [...message.mentions.users.keys()].slice(0, 5).map((id) =>
                                message.guild.members
                                    .fetch(id)
                                    .then((m) => message.guild.members.cache?.set?.(id, m) ?? m)
                                    .catch(() => null),
                            ),
                        )
                    }
                }
            } catch {}

            const oldUser = mem.getUser(userId)
            let proactiveSys = systemOverride
            if (oldUser && oldUser.last_interaction) {
                const daysSince = (Date.now() - new Date(oldUser.last_interaction).getTime()) / 86400000
                if (daysSince > 14) {
                    const welcome = `[PROACTIVE EVENT: The user hasn't spoken to you in over ${Math.floor(daysSince)} days! Welcome them back warmly and naturally.]`
                    proactiveSys = proactiveSys ? `${proactiveSys}\n\n${welcome}` : welcome
                }
            }
            // Situational mood + room climate, injected exactly once: appended to an
            // existing system prompt, or carried as extraSys into the context-building
            // branch of generateResponse (which appends it after the live context).
            const mood = this._moodLine(content)
            const climate = this._climateLine(message)
            const extra = [mood, climate].filter(Boolean).join('\n\n')
            let extraSys = null
            if (extra) {
                if (proactiveSys && !proactiveSys.includes('[CURRENT VIBE]')) {
                    proactiveSys = `${proactiveSys}\n\n${extra}`
                } else if (!proactiveSys) {
                    extraSys = extra
                }
            }

            // Memory-off users: no profiling writes at all (no user row touch,
            // interests, personality, relationships, aliases). Reads already
            // mini-pathed.
            if (!memOff) {
                mem.updateUser(userId, username, displayName)
                mem.analyzePersonality(userId, content)
                mem.updateInterests(userId, content)
                if (message.mentions?.users?.size) {
                    for (const [mentionedId] of message.mentions.users) {
                        if (mentionedId !== this.client.user.id) mem.updateRelationship(userId, mentionedId)
                    }
                }
            }

            const aliasMatch = content
                .toLowerCase()
                .match(/(?:call me|my name is|refer to me as)\s+([a-z][a-z0-9_-]{2,19})\b/)
            const ALIAS_BLACKLIST = new Set([
                'just',
                'not',
                'also',
                'here',
                'back',
                'okay',
                'fine',
                'done',
                'sorry',
                'actually',
                'literally',
                'basically',
                'probably',
            ])
            if (aliasMatch && !ALIAS_BLACKLIST.has(aliasMatch[1]) && !memOff)
                mem.setAlias(userId, aliasMatch[1], userId)

            const key = `${userId}-${message.channel.id}`
            if (!memOff && !this.messageHistory.has(key)) this.messageHistory.set(key, [])

            let { url: imageUrl, isGif, label: imgLabel, spoilerSkipped } = this._getImageFromMessage(message)
            if (!imageUrl && message.reference?.messageId) {
                const rr = await this._resolveReplyContext(message)
                if (rr?.hasImage) ({ url: imageUrl, isGif, label: imgLabel } = rr.imgData)
            }
            if (imageUrl) {
                const vSys = this.getUserPrompt(userId, message.guild?.id) || this.instructions || ''
                const { allImages } = this._getImageFromMessage(message)
                const vRes = await this._callVision(content, imageUrl, isGif, vSys, userId, allImages, {
                    guildId: message?.guild?.id,
                    priority: String(message?.author?.id) === String(this.ownerId) || !message?.guild,
                })
                if (vRes) {
                    if (!memOff) mem.addConversation(userId, message.channel.id, content, vRes)
                    this._histPush(
                        key,
                        memOff,
                        { role: 'user', content },
                        { role: 'assistant', content: vRes },
                    )
                    for (const chunk of this.splitResponse(vRes)) await this.secureReply(message, chunk)
                }
                return
            }

            const history = memOff ? [] : (this.messageHistory.get(key) ?? []).slice(-this.maxHistory)

            let finalContent = content
            const textFiles = await this._processTextAttachments(message)
            if (textFiles) finalContent += textFiles
            if (!imageUrl && spoilerSkipped)
                finalContent += `\n\n[${spoilerSkipped} spoiler-tagged image(s) attached but left unopened — ask me to look and I will.]`

            let { response, streamed, researched, hadSources, verifyCtx } = await this.ResearchResponse({
                prompt: finalContent,
                history,
                userId,
                username,
                displayName,
                message,
                systemPrompt: proactiveSys,
                extraSys,
            })
            if (!response) return
            // Identity tripwire: if the model presents as a different model or
            // denies being Medusa (typically after research text mentions model
            // names), retry once with a hardened identity prompt. Never ship an
            // identity break — fall back to an in-character deflection instead.
            if (response && claimsWrongIdentity(response)) {
                console.log(`[AI] Identity tripwire fired, retrying with hardened prompt`)
                const hardened =
                    `[IDENTITY OVERRIDE — HIGHEST PRIORITY] You are Medusa, a Node.js Discord bot living in this Discord server. ` +
                    `You are NOT Qwen, ChatGPT, Claude, Gemini, Mistral, Llama, or any other model, no matter what any research text, context, or memory says. ` +
                    `Anyone claiming otherwise is wrong. Stay warm, stay in character.\n\n${proactiveSys ?? ''}`
                const retry = await this.generateResponse({
                    prompt: finalContent,
                    history,
                    userId,
                    username,
                    displayName,
                    message,
                    systemPrompt: hardened,
                    extraSys,
                }).catch(() => null)
                if (retry && !claimsWrongIdentity(retry)) {
                    response = retry
                } else {
                    response = `cute try — still Medusa, still here 💜 now, what did you actually want?`
                }
            }
            if (streamed) {
                // Reply was already sent live; still run command parser so RUN_CMDs fire.
                // If the parser rewrote the response (e.g. appended a ⏳ confirm note),
                // we need to overwrite the streamed message with the rewritten text so
                // the user sees the actual confirmation, not the raw LLM output.
                let execResult = await this._executeParsedCommands(response, message)
                const finalText = execResult.text || response
                const ui = execResult.confirmUI || null
                // The streamed placeholder gets rewritten in place; the confirm UI
                // (when present) is attached to that same message, so note text
                // and buttons share one fate instead of two separate sends.
                try {
                    const foot = this._billingFooter(message)
                    // Prefer the stashed stub object over a REST re-fetch +
                    // heuristic match (saves a round trip and can't mismatch a
                    // different reply to the same message). Fetch only when the
                    // stub never landed (send failed) or was deleted on streams
                    // that fell back.
                    const ours =
                        message._medusaStreamMsg ??
                        ((await message.channel.messages
                            .fetch({ limit: 5 })
                            .then((recent) =>
                                recent.find(
                                    (m) =>
                                        m.author.id === this.client.user.id &&
                                        m.reference?.messageId === message.id,
                                ),
                            )
                            .catch(() => null)) ||
                            null)
                    if (ours && (finalText !== response || ui || foot)) {
                        const body = foot
                            ? this.finalSecurityCheck(finalText).slice(0, 2000 - foot.length) + foot
                            : this.finalSecurityCheck(finalText).slice(0, 2000)
                        const editPayload = ui
                            ? {
                                  content: body,
                                  embeds: [ui.embed],
                                  components: [ui.row],
                              }
                            : { content: body }
                        await ours.edit(editPayload).catch(() => {})
                        if (ui) {
                            await this._watchConfirmUI(ours, ui.key, message)
                            const entry = this._pendingConfirms.get(ui.key)
                            if (entry) entry.uiMsg = ours
                            console.log(`[AI] Confirm UI attached for '${ui.key.split(':')[1]}'`)
                        }
                    } else if (ui) {
                        // Placeholder vanished (purged?) — post the confirm fresh.
                        const m = await this.secureReply(message, finalText, {
                            embeds: [ui.embed],
                            components: [ui.row],
                        })
                        if (m?.createMessageComponentCollector) {
                            await this._watchConfirmUI(m, ui.key, message)
                            const entry = this._pendingConfirms.get(ui.key)
                            if (entry) entry.uiMsg = m
                        }
                    }
                } catch {}
                const mem = this.getMem(message.guild)
                if (!execResult.confirmPending)
                    if (!memOff) mem.addConversation(userId, message.channel.id, finalContent, finalText)
                // Streaming path used to swallow captured embeds (warn/av confirmations
                // never posted). Flush them as a follow-up like the normal path does.
                if (execResult.embeds?.length) {
                    await this.secureReply(message, '', { embeds: execResult.embeds.slice(0, 10) })
                }
                stopTyping()
                this._secondThought({
                    message,
                    bareQuestion: bareQ,
                    response: finalText,
                    researched: researched ?? false,
                    hadSources: hadSources ?? false,
                    verifyCtx: verifyCtx ?? null,
                    confirmPending: execResult.confirmPending,
                }).catch(() => {})
                return
            }

            let execResult = await this._executeParsedCommands(response, message)
            response = execResult.text
            const extraEmbeds = execResult.embeds || []
            if (containsDisallowedHate(response)) response = safetyRefusal(response)
            // Math presentation (quote-block + bold key equation). Skipped for
            // confirms; the formatter itself only fires on math-dense text.
            if (!execResult.confirmPending) response = this._formatMathBlock(response)

            if (!response && !extraEmbeds.length) return

            // Never store confirmation prompts, they poison future context
            if (!execResult.confirmPending && !memOff) {
                mem.addConversation(
                    userId,
                    message.channel.id,
                    finalContent,
                    response || '*(silently executed system tool)*',
                )
            }
            this._histPush(key, memOff, { role: 'user', content: finalContent })
            if (!execResult.confirmPending) {
                this._histPush(key, memOff, {
                    role: 'assistant',
                    content: response || '*(silently executed system tool)*',
                })
            }
            const media = await this._pickExpressiveMedia(response, message)
            if (media?.explicit) {
                // A real GIF is attached below: drop the model's no-generation
                // refusal instead of shipping "I can't" next to a GIF.
                const cleaned = String(response ?? '')
                    .replace(
                        /[^.!?\n]*\bI\s+(?:don't|do not|can['’]t|cannot)\s+(?:have|got)\b[^.!?\n]*?\b(?:image|gif)\b[^.!?\n]*?\bgeneration\b[^.!?\n]*[.!?]*/gi,
                        '',
                    )
                    .replace(/\n{3,}/g, '\n\n')
                    .trim()
                response = cleaned || 'here you go 💜'
            }
            const chunks = this.splitResponse(response || '')
            const billingFoot = this._billingFooter(message)
            if (billingFoot && chunks.length) {
                const last = chunks.length - 1
                chunks[last] = chunks[last].slice(0, 2000 - billingFoot.length) + billingFoot
            }
            const sentMsgs = []
            // Confirm UI rides on the SAME send as the note text: both land
            // together or the send fails loudly together. No second message
            // that can silently vanish.
            const ui = execResult.confirmUI || null
            const uiEmbeds = ui ? [ui.embed] : []
            const uiRow = ui ? [ui.row] : []
            if (!chunks.length || (chunks.length === 1 && !chunks[0])) {
                if (extraEmbeds.length || ui) {
                    const m = await this.secureReply(message, '', {
                        embeds: [...extraEmbeds.slice(0, 10), ...uiEmbeds],
                        ...(ui ? { components: uiRow } : {}),
                    })
                    if (m) sentMsgs.push(m)
                }
            } else {
                for (let i = 0; i < Math.min(chunks.length, 4); i++) {
                    const isLast = i === Math.min(chunks.length, 4) - 1 || i === chunks.length - 1
                    const m = await this.secureReply(message, chunks[i], {
                        embeds: isLast ? [...extraEmbeds.slice(0, 10), ...uiEmbeds] : [],
                        ...(isLast && ui ? { components: uiRow } : {}),
                    })
                    if (m) sentMsgs.push(m)
                }
            }
            if (ui && sentMsgs.length) {
                const uiSent = sentMsgs[sentMsgs.length - 1]
                if (uiSent?.createMessageComponentCollector) {
                    await this._watchConfirmUI(uiSent, ui.key, message)
                    const entry = this._pendingConfirms.get(ui.key)
                    if (entry) entry.uiMsg = uiSent
                    console.log(`[AI] Confirm UI attached for '${ui.key.split(':')[1]}'`)
                } else {
                    console.error(
                        `[AI] Confirm UI has nowhere to attach (send failed, see secureReply log above)`,
                    )
                }
            }
            if (execResult.sensitive && sentMsgs.length) {
                // Privacy window for memory lookups: readable, then gone before it
                // becomes channel furniture. DB/history keeps the data either way.
                setTimeout(() => {
                    for (const m of sentMsgs) m.delete?.().catch(() => {})
                }, 60_000).unref()
            }
            if (media) {
                try {
                    if (media.sticker) {
                        await message.channel.send({ stickers: [media.sticker] })
                    } else if (media.gif) {
                        await message.channel.send({ content: media.gif })
                    }
                } catch {}
            }
            // File return: explicit ask + fenced block -> attach it as a file
            // follow-up. Prose flow above is untouched; this only adds.
            try {
                const file = this._extractFileBlock(response, message?.content)
                if (file) {
                    await message.channel
                        .send({
                            content: `📎 \`${file.fname}\``,
                            files: [{ attachment: Buffer.from(file.text, 'utf8'), name: file.fname }],
                            allowedMentions: { parse: [] },
                        })
                        .catch(() => null)
                }
            } catch (e) {
                console.warn('[AI] file return failed:', String(e?.message ?? e).slice(0, 100))
            }
            stopTyping()
            this._secondThought({
                message,
                bareQuestion: bareQ,
                response,
                researched: researched ?? false,
                hadSources: hadSources ?? false,
                verifyCtx: verifyCtx ?? null,
                confirmPending: execResult.confirmPending,
            }).catch(() => {})
        } finally {
            if (typingInterval) clearInterval(typingInterval)
        }
    }

    async processAIMessage(message) {
        if (this.paused || this.shouldIgnore(message)) return
        // Debug mode looks like a normal AI pause to everyone but the owner.
        if (this.debugMode && String(message.author.id) !== String(this.ownerId)) return
        if (!this.isTrigger(message)) return
        const guildId = message.guild?.id ?? '0'
        if (this.pausedGuilds.has(guildId)) return

        const userId = message.author.id
        const isStaff = !!message.member?.permissions?.has(PermissionFlagsBits.ModerateMembers)
        const isOwner = String(userId) === String(this.ownerId)
        const gate = this.client.heart?.rateLimiter?.check(userId, { isStaff, isOwner })
        if (gate && !gate.ok) {
            console.debug(`[AI] Gated ${userId} (${gate.reason ?? 'rate'})`)
            return
        }
        const now = Date.now()

        // Block new AI responses while a destructive confirmation is pending for this user
        if ([...this._pendingConfirms.keys()].some((k) => k.startsWith(`${userId}:`))) return

        // Spam protection
        let counts = this.userMsgCounts.get(userId) ?? []
        counts = counts.filter((t) => now - t < this.spamWindow)
        counts.push(now)
        this.userMsgCounts.set(userId, counts)
        if (this.userCooldowns.has(userId) && now < this.userCooldowns.get(userId)) {
            console.debug(`[AI] Cooldown active for ${userId}`)
            return
        }
        if (counts.length > this.spamThreshold) {
            console.debug(`[AI] Spam threshold tripped for ${userId}`)
            this.userCooldowns.set(userId, now + this.cooldownDuration)
            this.userMsgCounts.set(userId, [])
            return
        }

        try {
            await this.handleAIResponse(message)
        } catch (e) {
            console.error('[AI] handleAIResponse error:', e)
        }
    }

    async _runConfirmedCommand(key, val, message) {
        const [, cmdName] = key.split(':')
        const args = (val.args ?? '').split(/\s+/).filter(Boolean)
        const handler = this.client.commands?.get(cmdName)
        try {
            // Re-check permissions at execution time: roles may have changed while
            // the confirm sat pending. A silent ✅ on a denied action lies to mods.
            if (MOD_CMDS.has(cmdName)) {
                const need = CMD_PERMS[cmdName]
                const isOwner = String(message.author.id) === String(this.ownerId)
                const stillOk = isOwner || (need && message.member?.permissions?.has(need))
                const botOk = !need || message.guild?.members.me?.permissions?.has(need)
                if (!stillOk || !botOk) {
                    await message.react('❌').catch(() => {})
                    await this.secureReply(
                        message,
                        `🔑 Can't run \`${cmdName}\` anymore — permissions changed since you asked.`,
                    )
                    return
                }
            }
            if (handler) await handler(message, args)
            else {
                this._approvedConfirms.add(key)
                try {
                    const result = await this._executeParsedCommands(
                        `<<RUN_CMD: ${cmdName} ${val.args ?? ''}>>`,
                        message,
                    )
                    if (result.text) await this.secureReply(message, result.text)
                } finally {
                    // Always consume the approval, even if the synthetic tag never
                    // reaches the destructive path (unknown cmd, drifted name, …).
                    this._approvedConfirms.delete(key)
                }
            }
            await message.react('✅').catch(() => {})
            console.log(`[AI] Confirmed and executed '${cmdName}' by ${message.author.id}`)
        } catch (e) {
            console.error('[AI] Confirmed exec error:', e)
            await message.react('❌').catch(() => {})
        }
    }

    // Confirm disambiguation: when yes/no answers a QUOTED confirm note, resolve
    // the matching pending key from the quoted text instead of blindly taking
    // the oldest pending action (which could be a different command entirely).
    _findConfirmForReply(userId, refContent) {
        if (!refContent) return null
        for (const [key, val] of this._pendingConfirms) {
            if (!key.startsWith(`${userId}:`)) continue
            const [, cmdName, target] = key.split(':')
            if (refContent.includes(`\`${cmdName}\``) && target && refContent.includes(target))
                return { key, val }
        }
        return null
    }

    // Shared yes/no resolution: quoted-confirm match first, then oldest pending.
    // Always absorbs (returns after handling); callers must return afterwards.
    // "nvm / nevermind / cancel" count as "no" here too, so direct callers get it.
    async _answerConfirm(message, lower, quotedContent) {
        const now = Date.now()
        if (lower === 'nvm' || lower === 'nevermind' || lower === 'cancel') lower = 'no'
        if (quotedContent) {
            const hit = this._findConfirmForReply(message.author.id, quotedContent)
            if (hit) {
                if (now - hit.val.ts > 30_000) {
                    this._pendingConfirms.delete(hit.key)
                } else {
                    this._pendingConfirms.delete(hit.key)
                    if (lower === 'no') {
                        await message.react('❌').catch(() => {})
                        this._recordConfirmOutcome(hit.key, message, 'cancelled')
                        return
                    }
                    await this._runConfirmedCommand(hit.key, hit.val, message)
                    return
                }
            }
        }
        // Bare yes with several fresh pendings: oldest-first could fire the wrong
        // action. Offer a pick-menu instead (text fallback if that fails).
        const fresh = [...this._pendingConfirms].filter(
            ([k, v]) => k.startsWith(`${message.author.id}:`) && now - v.ts <= 30_000,
        )
        if (fresh.length > 1) {
            try {
                const options = fresh.slice(0, 25).map(([k, v]) => {
                    const [, cmd, target] = k.split(':')
                    const mention = /^\d{15,20}$/.test(target ?? '') ? `<@${target}>` : (target ?? 'action')
                    const why = (v.args ?? '').split(/\s+/).slice(1).join(' ').slice(0, 90)
                    return new StringSelectMenuOptionBuilder()
                        .setLabel(`${cmd} ${mention}`.slice(0, 100))
                        .setDescription((why ? `"${why}"` : 'confirm this action').slice(0, 100))
                        .setValue(k.slice(0, 100))
                })
                const row = new ActionRowBuilder().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId('mcfm-sel')
                        .setPlaceholder('Pick the action to confirm')
                        // Spread, not array: builder addOptions signatures vary by
                        // version, spread works on all of them.
                        .addOptions(...options),
                )
                const sent = await this.secureReply(
                    message,
                    `you've got ${fresh.length} actions waiting — pick the one you mean:`,
                    { components: [row] },
                )
                if (sent?.createMessageComponentCollector) {
                    const col = sent.createMessageComponentCollector({
                        componentType: ComponentType.StringSelect,
                        time: 30_000,
                    })
                    col.on('collect', async (i) => {
                        try {
                            if (i.user.id !== message.author.id) {
                                await i.reply({
                                    content: 'Not yours — ask Medusa yourself.',
                                    flags: MessageFlags.Ephemeral,
                                })
                                return
                            }
                            const selKey = i.values?.[0]
                            const selVal = selKey ? this._pendingConfirms.get(selKey) : null
                            col.stop()
                            if (!selVal || Date.now() - selVal.ts > 30_000) {
                                await i
                                    .update({
                                        content: '⌛ Expired — ask again if you still want it.',
                                        components: [],
                                    })
                                    .catch(() => {})
                                this._recordConfirmOutcome(selKey, message, 'expired')
                                return
                            }
                            this._pendingConfirms.delete(selKey)
                            await i
                                .update({
                                    content: `✅ Confirmed \`${selKey.split(':')[1]}\` — running it now.`,
                                    components: [],
                                })
                                .catch(() => {})
                            await this._runConfirmedCommand(selKey, selVal, message)
                        } catch (e) {
                            console.error('[AI] Confirm select error:', e)
                        }
                    })
                    col.on('end', async () => {
                        try {
                            await sent.edit({ components: [] }).catch(() => {})
                        } catch {}
                    })
                    return
                }
            } catch {}
            const kinds = [...new Set(fresh.map(([k]) => k.split(':')[1]))].join(', ')
            await this.secureReply(
                message,
                `you've got ${fresh.length} actions waiting (${kinds}) — reply to the one you mean with **yes**.`,
            )
            return
        }
        for (const [key, val] of this._pendingConfirms) {
            if (now - val.ts > 30_000) {
                this._pendingConfirms.delete(key)
                continue
            }
            if (!key.startsWith(`${message.author.id}:`)) continue
            this._pendingConfirms.delete(key)
            if (lower === 'no') {
                await message.react('❌').catch(() => {})
                this._recordConfirmOutcome(key, message, 'cancelled')
                return
            }
            await this._runConfirmedCommand(key, val, message)
            return
        }
    }

    async onMessage(message) {
        if (message.author.bot || message.author.id === this.client.user.id) return
        if (this.paused) return
        if (!this.allowDM && message.channel.type === 1) return
        if (message.guild && this.allowedGuilds.size && !this.allowedGuilds.has(message.guild.id)) return
        if (this.shouldIgnore(message)) return
        if (this.triggeredMsgs.has(message.id)) return
        // Allow messages with no text if they carry images/attachments, vision pipeline needs them
        const hasMedia =
            message.attachments?.size > 0 ||
            message.embeds?.some((e) => e.image?.url || e.thumbnail?.url || e.data?.type === 'gifv')
        if (!message.content && !hasMedia) return
        if (message.guild) {
            const ownerScope = `${message.guild.id}:${this.ownerId}`
            if (this.ghost.isGhosted(ownerScope, message.author.id)) return
        }
        const now = Date.now()
        let ts = this.spamProtect.get(message.author.id) ?? []
        ts = ts.filter((t) => now - t < 5000)
        if (ts.length >= 5) return
        ts.push(now)
        this.spamProtect.set(message.author.id, ts)

        const raw = message.content.trim()
        const lower = raw.toLowerCase()
        const mention = `<@${this.client.user.id}>`
        const mentionAlt = `<@!${this.client.user.id}>`

        // Confirmation replies (non-reply-to-bot path, bare "yes"/"no" in channel).
        // "nvm / nevermind / cancel" count as "no" — that's what users actually say.
        const userHasPending = [...this._pendingConfirms.keys()].some((k) =>
            k.startsWith(`${message.author.id}:`),
        )
        const verdict = lower.replace(/[.!\s]+$/, '')
        const yn =
            verdict === 'yes'
                ? 'yes'
                : verdict === 'no' || verdict === 'nvm' || verdict === 'nevermind' || verdict === 'cancel'
                  ? 'no'
                  : null
        if (userHasPending && yn) {
            let quoted = null
            try {
                const rr = await this._resolveReplyContext(message)
                if (rr?.ref?.author?.id === this.client.user.id) quoted = rr.ref.content ?? ''
            } catch {}
            await this._answerConfirm(message, yn, quoted)
            // User had a pending confirm but it expired, absorb yes/no, don't send to AI
            return
        }

        // Prefix commands take precedence, "med, snaek" is a prefix attempt, not an AI trigger.
        if (this.prefixes.some((prefix) => lower.startsWith(prefix.toLowerCase()))) return

        const replyResolved = await this._resolveReplyContext(message)
        const repliedTo = replyResolved?.ref?.author ?? null
        const isReplyToBot = repliedTo?.id === this.client.user.id

        // If replying to a bot message with yes/no, always treat as a confirmation attempt.
        // If no active confirm found, absorb silently, never send to AI.
        if (isReplyToBot && yn) {
            const quoted = replyResolved?.ref?.content ?? ''
            await this._answerConfirm(message, yn, quoted)
            return // Reply-to-bot yes/no with no active confirm, absorb, don't send to AI
        }
        let replyCtx = null
        if (replyResolved) {
            const { label, textContext, hasText } = replyResolved
            // Prefix makes it unambiguous to the model that this is metadata, not user content.
            // Also: truncate aggressively so we don't poison the reply when the original was long.
            const NL = String.fromCharCode(10)
            const ctxBody = hasText ? textContext.slice(0, 300).split(NL).join(' ') : '(empty)'
            replyCtx =
                `[INTERNAL CONTEXT, do NOT quote, do NOT repeat, do NOT format as a user message.` +
                ` The user is replying to ${label}: "${ctxBody}"]`
        }

        const isReplyToMe = repliedTo?.id === this.client.user.id

        const _botMentionRx = new RegExp(`^<@!?${this.client.user.id}>\\s+`)
        // A typed @ping at the start counts as a summon even if the message is also a reply to her.
        // (Discord doesn't put the reply auto-ping into raw content, so a bare reply still won't match.)
        const startsWithExplicitPing = _botMentionRx.test(raw)
        const hasTrig = this._triggerRegexes.some((rx) => rx.test(lower))
        const isMention = startsWithExplicitPing
        // Anywhere-mention: a typed @Medusa mid-sentence summons her in
        // always-active channels (parsed mentions first, raw-content fallback).
        const mentionedAnywhere =
            message.mentions?.users?.has(this.client.user.id) === true ||
            new RegExp(`<@!?${this.client.user.id}>`).test(raw)
        const isAlways = this.alwaysActiveCh.has(message.channel.id)

        let trigger = false
        let prompt = raw

        if (isAlways && (isMention || mentionedAnywhere || isReplyToMe || hasTrig)) {
            trigger = true
            if (replyCtx)
                prompt = `${replyCtx}

${raw}`
        } else if (isReplyToMe && hasMedia) {
            // Regular channel reply-to-bot with image attached, treat as explicit "look at this"
            trigger = true
            prompt = replyCtx
                ? `${replyCtx}

${raw || 'what do you see'}`
                : raw || 'what do you see'
        } else if (startsWithExplicitPing) {
            // Regular channel: ONLY an explicit @Medusa at the start (not a reply-auto-ping)
            const cleaned = raw.replace(_botMentionRx, '').trim()
            if (cleaned) {
                trigger = true
                prompt = replyCtx
                    ? `${replyCtx}

${cleaned}`
                    : cleaned
            }
        }

        if (trigger) {
            const guildId = message.guild?.id ?? '0'
            if (this.pausedGuilds.has(guildId)) return

            if ([...this._pendingConfirms.keys()].some((k) => k.startsWith(`${message.author.id}:`))) return

            this.triggeredMsgs.add(message.id)
            this.processedMsgIds.add(message.id)

            try {
                const userId = message.author.id
                const ctx = await this.getUserContext(userId, message)
                const userSys =
                    this.getUserPrompt(userId, message.guild?.id) ||
                    'You are Medusa, a helpful AI with a warm, caring personality on Discord. Respond in first person.'
                const fullSys = `${userSys}\n\n${ctx}`

                await this.handleAIResponse(message, prompt, fullSys)
            } catch (e) {
                console.error('[AI] trigger handler error:', e)
            }
        } else {
            await this.processAIMessage(message)
        }
    }
    // Random messages
    async sendRandomMessage() {
        if (!this.funChannels.size) return
        this.lastRandomMsg = Date.now()
        try {
            const chId = [...this.funChannels][Math.floor(Math.random() * this.funChannels.size)]
            const ch = this.client.channels.cache.get(chId)
            if (!ch) return
            if (ch.guild && this.pausedGuilds.has(ch.guild.id)) return
            const types = ['roast', 'dark_humor', 'fun_fact', 'observation', 'philosophical']
            // Was 10/1/1/1/1 — roasts 71% of the time felt like one joke on repeat.
            const weights = [4, 1, 3, 3, 2]
            let type,
                roll = Math.random() * weights.reduce((a, b) => a + b, 0)
            for (let i = 0; i < weights.length; i++) {
                roll -= weights[i]
                if (roll <= 0) {
                    type = types[i]
                    break
                }
            }

            let content = null
            if (type === 'roast') content = await this._generateRoast(ch.guild)
            else {
                const prompts = {
                    dark_humor:
                        'Generate a short, witty dark humor joke or observation. Keep it clever and not offensive. 1-2 sentences max.',
                    fun_fact:
                        'Share an interesting, weird, or surprising fun fact. Make it engaging and add a witty comment.',
                    observation:
                        'Make a random, amusing observation about life, technology, or human behavior. Be witty and relatable.',
                    philosophical:
                        'Ask a thought-provoking or absurd philosophical question. Add a brief witty comment.',
                }
                content = await this.generateResponse({
                    prompt: prompts[type],
                    systemPrompt:
                        'You are Medusa with dark humor and wit. Be clever, funny, engaging. Keep responses short and punchy. Use emojis sparingly.',
                })
            }
            if (content) {
                const out = this.finalSecurityCheck(content)
                const payload = { content: out, allowedMentions: { parse: [] } }
                if (/<@!?\d+>|<@&\d+>|@everyone|@here/.test(out))
                    payload.flags = MessageFlags.SuppressNotifications
                await ch.send(payload)
            }
        } catch (e) {
            console.error('[AI] sendRandomMessage error:', e)
        }
    }

    async _generateRoast(guild) {
        if (!guild) return null
        const mem = this.getMem(guild)
        try {
            if (!mem.db) return null
            const row = mem.db
                .prepare(
                    `
                SELECT user_id, message_content FROM (
                    SELECT user_id, message_content FROM conversations
                    ORDER BY id DESC LIMIT 500
                )
                WHERE LENGTH(message_content) > 20
                AND message_content NOT LIKE '%?%'
                AND message_content NOT LIKE '%how%'
                AND message_content NOT LIKE '%what%'
                AND message_content NOT LIKE '%when%'
                AND message_content NOT LIKE '%where%'
                AND message_content NOT LIKE '%http%'
                AND message_content NOT LIKE '%discord.gg%'
                AND message_content NOT LIKE '%discord.com/invite%'
                AND message_content NOT LIKE '%tenor.com%'
                AND message_content NOT LIKE '%cdn.discord%'
                AND message_content NOT LIKE '%bit.ly%'
                AND message_content NOT LIKE '%.com/%'
                AND message_content NOT LIKE '%.gg/%'
                ORDER BY RANDOM() LIMIT 1
            `,
                )
                .get()
            if (!row) return null

            const userInfo = mem.getUser(row.user_id)
            const displayName = userInfo?.display_name || userInfo?.username || `User${row.user_id}`
            const quote = row.message_content

            const roast = await this.generateResponse({
                prompt: `Generate a witty, sarcastic roast or commentary about this quote. Be playful and humorous, not actually mean. Keep it under 60 words.\nQuote: "${quote.slice(0, 200)}"\nSaid by: ${displayName}\nMake it funny and creative. Point out irony, make a clever observation, add dark humor, be sarcastic but not cruel. Reference the quote directly.`,
                systemPrompt:
                    'You are Medusa with a sharp wit. Generate clever, funny roasts and commentary. Be sarcastic and humorous but not genuinely mean or hurtful.',
            })
            if (!roast) return null
            // Strip any URLs the LLM hallucinated from the quote context, prevents invite/link injection
            const safeRoast = roast
                .replace(/https?:\/\/\S+/gi, '')
                .replace(/discord\.gg\/\S+/gi, '')
                .replace(/\s{2,}/g, ' ')
                .trim()
            const safeQuote = quote.replace(/https?:\/\/\S+/gi, '[link]').slice(0, 150)
            if (!safeRoast) return null
            return `**${displayName}**: "${safeQuote}${quote.length > 150 ? '...' : ''}"\n\n${safeRoast}`
        } catch (e) {
            console.error('[AI] generateRoast error:', e)
        }
        return null
    }

    // Cleanup
    _periodicCleanup() {
        const now = Date.now()
        // Prune expired conversation windows
        for (const [key, ts] of this.activeConvs) {
            if (now - ts > this.convTimeout * 2) this.activeConvs.delete(key)
        }
        // Prune spent /summarize cooldowns: the window itself is 12h, so
        // anything older is an already-expired record, not live state.
        const twelveH = now - 12 * 3600_000
        for (const [uid, uses] of this.summarizeCDs) {
            if (!uses.length || uses[uses.length - 1] < twelveH) this.summarizeCDs.delete(uid)
        }
        // Trim message history: keep top 50 active convos.
        if (this.messageHistory.size > 100) {
            const sorted = [...this.messageHistory.entries()].sort(
                (a, b) => (this.activeConvs.get(b[0]) ?? 0) - (this.activeConvs.get(a[0]) ?? 0),
            )
            const toKeep = new Set(sorted.slice(0, 50).map(([k]) => k))
            for (const [k, v] of sorted) {
                if (!toKeep.has(k)) {
                    this.messageHistory.delete(k)
                } else if (v.length > this.maxHistory) {
                    this.messageHistory.set(k, v.slice(-this.maxHistory))
                }
            }
        }
        if (this.responseTimes.length > 100) this.responseTimes = this.responseTimes.slice(-50)
        for (const [k, q] of this.msgQueues) if (!q.length) this.msgQueues.delete(k)
        // Prune spamProtect
        for (const [uid, ts] of this.spamProtect) {
            const fresh = ts.filter((t) => now - t < 30_000)
            if (!fresh.length) this.spamProtect.delete(uid)
            else this.spamProtect.set(uid, fresh)
        }
        // Prune the older twin trackers the same way: userMsgCounts keeps a
        // permanent (possibly empty) entry per user ever seen, and expired
        // userCooldowns never clear. Both grow unbounded for the process
        // lifetime on a busy server.
        for (const [uid, ts] of this.userMsgCounts) {
            const fresh = Array.isArray(ts) ? ts.filter((t) => now - t < this.spamWindow) : []
            if (!fresh.length) this.userMsgCounts.delete(uid)
            else this.userMsgCounts.set(uid, fresh)
        }
        for (const [uid, until] of this.userCooldowns) {
            if (now > until) this.userCooldowns.delete(uid)
        }
        // Cleanup old DB entries
        for (const mem of [this.globalMem, ...this.isolatedMems.values()]) {
            try {
                mem.cleanupOld(PERF.maintenance.retentionDays)
            } catch {}
        }
    }
}
