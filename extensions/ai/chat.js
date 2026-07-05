// Chat core: context assembly, trigger decisions, generation (stateful +
// quick-agent stateless), research responses, and the message pipeline.
import crypto from 'crypto'
import { PermissionFlagsBits } from 'discord.js'
import { existsSync, readFileSync, readdirSync, renameSync } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import { LRUCache } from 'lru-cache'
import { join } from 'path'
import { performance } from 'perf_hooks'
import { loadPerformance } from '../performance.js'
import { CAPABILITIES_NOTE, NO_SEARCH_SIGNALS, SEARCH_EMOJIS, makeIdSet } from './constants.js'
import { AIMemoryManager, GhostUsers } from './memory.js'
import { OutputCore } from './output.js'

const PERF = loadPerformance()

export class AIChatManager extends OutputCore {
    constructor(client, db, config) {
        // Required: OutputCore → AgentCommandCore → VisionCore → ResearchCore → ProviderCore.
        // None define their own constructor, so a no-arg super() walks the whole chain.
        super()
        this.client = client
        this.db = db

        // Config — already normalized to the canonical shape by extensions/config.js
        this.config = config
        this._config = config
        const { agents } = config
        this.aiModel = agents.chat.model
        this.researchModel = agents.research.model
        this.visionModel = agents.vision.model
        this.classifierModel = agents.classifier.model
        this.capacityFallbacks = config.fallbackModels
        this.instructions =
            agents.chat.systemPrompt ||
            'You are Medusa, a warm and witty Discord AI resident. Respond in first person.'
        this.prefix = config.prefix
        this.maxHistory = config.memoryDepth ?? PERF.ai.memoryDepth
        this.allowDM = config.allowDMs
        this.funMsgInterval = config.funMsgInterval * 1000

        // Sampling — every agent shares one shape: model/temperature/topP/maxTokens
        this.temperature = agents.chat.temperature
        this.topP = agents.chat.topP
        this.chatTokens = agents.chat.maxTokens
        this.researchTemp = agents.research.temperature
        this.searchTokens = agents.research.maxTokens
        this.visionTemp = agents.vision.temperature
        this.visionTokens = agents.vision.maxTokens

        // Scope — derived from the guilds{} map + channel lists
        this.allowedGuilds = new Set(config.guildIds)
        this.aiAllowedGuilds = new Set(config.aiGuildIds)
        this.alwaysActiveCh = new Set(config.alwaysActiveChannels)
        this.funChannels = new Set(config.funChannels)
        this.isolatedServers = new Set(config.isolatedGuildIds)
        this.triggerWords = config.triggers.length ? config.triggers : ['medusa']
        // Pre-compile trigger regexes once (avoids re-compilation on every message)
        this._triggerRegexes = this.triggerWords.map(
            (w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`),
        )

        // Credentials — the chat agent's resolved provider is the primary client;
        // rotateKey() walks these keys on 429/401.
        this.aiTokens = agents.chat.resolved.keys
        this.llmBaseUrl = agents.chat.resolved.baseUrl
        this.ownerId = config.ownerId
        this.ownerName = config.ownerName
        this.currentKeyIdx = 0
        this.deadKeys = new Set()
        this.keyFailures = {}
        this.researchKeys = agents.research.resolved?.keys ?? []
        this.currentResearchKeyIdx = 0
        this.maxFailures = 2
        this._pendingConfirms = new Map()
        this._loadDeadKeys()
        this._groq = null
        this._initGroq()
        this._initProviders()

        // Caches — sized by performance.json so host tiering holds under load
        const P = PERF.ai
        this.responseCache = new LRUCache({
            max: P.responseCacheMax,
            ttl: P.responseCacheTTLSec * 1000,
            updateAgeOnGet: true,
            allowStale: true,
            maxSize: P.responseCacheMaxMB * 1024 * 1024,
            sizeCalculation: (value) => (typeof value === 'string' ? value.length : 1024),
        })
        this.userCache = new LRUCache({ max: P.userCacheMax, ttl: P.userCacheTTLSec * 1000 })
        this.messageHistory = new LRUCache({
            max: P.messageHistoryMax,
            ttl: P.messageHistoryTTLMin * 60_000,
        })
        this.repliedMsgCache = new LRUCache({
            max: P.repliedMsgCacheMax,
            ttl: P.repliedMsgCacheTTLMin * 60_000,
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
        this.pingMode = config.pingMode
        this.replyPing = config.replyPing

        // Memory managers — global plus one per isolated guild (created lazily)
        this.globalMem = new AIMemoryManager()
        this.isolatedMems = new Map()

        // Custom prompts / modes
        this.customPrompts = this._loadJSON('Ai Database/custom_prompts.json', {})
        this.userModes = this._loadJSON('Ai Database/user_modes.json', {})

        // Ghost users
        this.ghost = new GhostUsers()

        // Stats
        this.totalRequests = 0
        this.errorCount = 0
        this.responseTimes = []
        this.lastRandomMsg = Date.now()

        // Background tasks
        setInterval(() => this._periodicCleanup(), PERF.maintenance.cleanupIntervalMin * 60_000).unref()
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
            return JSON.parse(raw.replace(/\b(\d{15,})\b/g, '"$1"'))
        } catch {}
        return fallback
    }
    async _saveJSON(path, data) {
        try {
            await mkdir(path.split('/').slice(0, -1).join('/'), { recursive: true })
            await writeFile(path, JSON.stringify(data, null, 2))
        } catch {}
    }
    getMem(guild) {
        if (!guild || !this.isolatedServers.has(guild.id)) return this.globalMem
        if (!this.isolatedMems.has(guild.id)) {
            this._resolveAndSync(guild)
            this.isolatedMems.set(guild.id, new AIMemoryManager(guild.id, guild.name))
        }
        return this.isolatedMems.get(guild.id)
    }

    /** Scan Ai Database/ for any folder ending with " - {guildId}" and rename it if the guild name changed */
    _resolveAndSync(guild) {
        try {
            const dataDir = 'Ai Database'
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
                    console.log(`[AI] Renamed bare-ID folder "${guild.id}" → "${expectedFolder}"`)
                } catch (e) {
                    console.warn(`[AI] Could not rename bare-ID folder:`, e.message)
                }
                return
            }
            for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
                if (!entry.isDirectory() || !entry.name.endsWith(suffix)) continue
                if (entry.name === expectedFolder) return
                // Found old-name folder — rename to match current guild name
                const oldPath = join(dataDir, entry.name)
                try {
                    renameSync(oldPath, expectedPath)
                    console.log(`[AI] Synced folder: "${entry.name}" → "${expectedFolder}"`)
                } catch (e) {
                    console.warn(`[AI] Could not sync folder "${entry.name}":`, e.message)
                }
                return
            }
        } catch {}
    }

    getUserPrompt(userId) {
        if (!userId) return this.instructions
        if (this.userModes[userId] === 1)
            return `You are Medusa in focused mode. Highly intelligent and analytical. Concise and direct. Task-oriented and solution-focused. Professional but still personable. Skip casual chat, focus on helping efficiently. Use minimal emojis, be more formal. Get straight to the point. Respond in first person as Medusa.`
        if (this.customPrompts[userId]) return this.customPrompts[userId]
        return this.instructions
    }
    // Reply context resolution
    // Fetches the replied-to message when reference.resolved is null (uncached).
    // Builds a rich context object covering text, images, links and embeds —
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
        this.repliedMsgCache.set(message.id, ref)

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
            if (!isImg) parts.push(`[Attachment: ${att.name} — ${att.url}]`)
        }

        // Embeds: links, rich embeds, articles — incl. fields/footer/provider where bots (Last.fm, "now playing", etc.) put the real payload
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
            if (bits.length) parts.push(`[Embed — ${bits.join(' | ')}]`)
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
        const msgText = (message?.content ?? '').trim()
        if (
            msgText &&
            msgText.split(/\s+/).length <= 3 &&
            /^(hi|hey|hello|yo|sup|ty|thanks|bye|cya|gn|gm|ok|lol|lmao|💜|💚|·)\b/i.test(msgText)
        ) {
            const name = message.member?.displayName ?? message.author?.username ?? 'user'
            const mini = `ACTIVE USER: ${name} (<@${message.author.id}>)
TIME: ${new Date().toISOString().slice(0, 16)} UTC`
            this.userCache.set(cacheKey, mini)
            return mini
        }

        const mem = this.getMem(message?.guild)
        // Load ghost list for this user in this guild so buildContext can filter channel context
        const ghostScope = message?.guild ? `${message.guild.id}:${userId}` : null
        const ghostedIds = ghostScope ? this.ghost.list(ghostScope) : []
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
                `▶ ACTIVE USER — the person replying to you RIGHT NOW (do NOT attribute things from RECENT CHANNEL ACTIVITY to them):`,
            )
            parts.push(
                displayName !== message.author.username
                    ? `  ${displayName} (@${message.author.username}) | ID: <@${message.author.id}> | Moderator: ${isMod}`
                    : `  @${message.author.username} | ID: <@${message.author.id}> | Moderator: ${isMod}`,
            )
        }

        // Live channel buffer — recent messages from others in this channel
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
                    '[INTERNAL — background chatter from OTHER users, for your awareness only. DO NOT quote, summarize, or address these users unless the active user explicitly mentions them.]',
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
        // (Already near the bottom — just flag: don't move it higher.)
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
        const _canResearch = !!this._researchClient && (_realKey(_cfg.search?.tavilyKey) || _realKey(_cfg.search?.serperKey))
        parts.push(
            `YOUR MODEL/RUNTIME: You run on "${this.aiModel}" via ${_provider} (vision: "${this.visionModel}", research: "${this.researchModel}"). ` +
                `Capabilities: image vision, long-term memory${_canResearch ? ', live web research' : ''}. ` +
                `If asked what AI or model you are, answer truthfully with this model and provider — never claim to be ChatGPT, Claude, or Gemini unless that is literally the model named above.`,
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
                const e = ref.embeds.find((x) => x.data?.type !== 'image' && x.data?.type !== 'gifv') ?? ref.embeds[0]
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
    async generateStatelessResponse({ prompt, forceSearch = false }) {
        if (!this._groq) return null

        // Quick Agent settings are normalized (prompt arrays pre-joined) by config.js
        const { model, temperature, topP, maxTokens, allowResearch } = this._config.agents.quickAgent
        const systemPrompt = this._config.agents.quickAgent.systemPrompt || this._defaultQuickAgentPrompt()

        const routing =
            allowResearch && forceSearch
                ? 'research'
                : allowResearch
                  ? await this.needsResearch(prompt)
                  : 'direct'
        // Only 'dangerous' (illegal) hard-refuses. 'nsfw'-labelled prompts fall through to
        // the model, which answers non-explicitly per its prompt — the old flat refusal
        // fired on merely edgy questions and read as closed-minded.
        if (routing === 'dangerous') return "I can't help with that."

        const runDirect = async (finalPrompt, sys) => {
            const messages = [
                { role: 'system', content: sys },
                { role: 'user', content: String(finalPrompt).slice(0, 20000) },
            ]
            // topP is threaded as a call-scoped argument — no shared this.topP mutation, so
            // concurrent stateless calls can't race on each other's sampling settings.
            return await this._groqCallWithFallbacks(messages, model, maxTokens, temperature, topP)
        }

        if (routing === 'research') {
            const raw = await this._callResearch(prompt)
            if (raw) {
                const { text, sources } = this._parseSources(raw)
                const researchPrompt =
                    `Research data for the question below. Treat it as ground truth.
` +
                    `${'-'.repeat(32)}
${text.slice(0, 3500)}
${'-'.repeat(32)}

` +
                    `Question: ${prompt}

Answer concisely using the research.`
                // Research answers must pass the same hard-strip as direct ones —
                // RUN_CMD/mass-ping stripping is not optional on any path.
                const final = this._sanitizeStateless(await runDirect(researchPrompt, systemPrompt))
                if (final && sources.length) {
                    const footer = `
-# ${sources.map((s) => `[${s.name}](<${s.url}>)`).join(' · ')}`
                    return final.length + footer.length <= 2000 ? final + footer : final
                }
                if (final) return final
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
            'You are Quick-Agent — a stateless assistant invoked via slash command.',
            'No memory, no server/channel context, no tools, no command execution.',
            'Treat every invocation as a one-shot question.',
            '',
            'MODE:',
            '- Sharp, direct, analytically precise. Skip greetings, filler, and roleplay.',
            "- Professional-casual by default. Mirror the user's tone when they set one.",
            '- Answer directly in the first sentence. Expand only when necessary.',
            '- Use Discord markdown where it aids clarity, not decoration.',
            "- Never claim to remember anything — you don't.",
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
    }) {
        if (!this._groq) return null
        this.totalRequests++
        const t0 = performance.now()

        try {
            // Cache for short identical prompts
            let cacheKey = null
            if (userId && prompt.length < 200) {
                cacheKey = crypto
                    .createHash('md5')
                    .update(`${userId}:${prompt}:${systemPrompt ?? ''}`)
                    .digest('hex')
                const cached = this.responseCache.get(cacheKey)
                if (cached) return cached
            }

            // Inject CAPABILITIES_NOTE only when the prompt plausibly needs a RUN_CMD.
            // Skipping it on casual chat shaves ~1.5 KB of prefill → measurable TTFT drop.
            const ACTION_RE =
                /\b(ban|kick|mute|unmute|warn|purge|clear|mpurge|fpurge|delete|remove|lock|unlock|role|nickname|rename|avatar|av|pfp|banner|bn|announce|poll|thread|pin|unpin|slowmode|topic|react|emoji|movevc|dm|show|fetch|pull up)\b/i
            const needsCaps = ACTION_RE.test(prompt) || ACTION_RE.test(message?.content ?? '')

            const messages = []
            if (systemPrompt) {
                messages.push({
                    role: 'system',
                    content: needsCaps ? systemPrompt + CAPABILITIES_NOTE : systemPrompt,
                })
            } else {
                let base =
                    this.getUserPrompt(userId) ||
                    "You are Medusa, a vibrant AI assistant with personality. Respond as yourself in first person. Be expressive, use emojis occasionally. You're helpful but also playful, witty, and engaging."
                if (needsCaps) base += CAPABILITIES_NOTE
                if (userId) {
                    const ctx = await this.getUserContext(userId, message)
                    const convoCtx = history?.length
                        ? `CONVERSATION FLOW: You have exchanged ${history.length} recent messages back and forth in this active conversation.`
                        : ''
                    const finalSys =
                        `[IDENTITY & PERSONA]\n${base}\n\n[CONVERSATION FLOW]\n${convoCtx}\n\n[LIVE CONTEXT & AGENT DUTY]\n${ctx}`.trim()
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
            // for destructive commands — those need to be intercepted, rewritten into
            // a confirmation prompt, and stored in _pendingConfirms BEFORE the user
            // sees anything. Streaming shows raw LLM output and breaks that flow.
            const mayEmitCmd = /\b(ban|kick|mute|warn|mpurge|clear|purge|fpurge|delchan|announce|dm)\b/i.test(
                prompt || '',
            )
            // Scale token budget to prompt length. Short "hey" doesn't need 1200 tokens reserved.
            // NIM's KV cache allocation respects max_completion_tokens on many deployments,
            // so a lower value = faster first token and lower queue pressure under load.
            const wordCount = (prompt || '').split(/\s+/).length
            const adaptiveMax = wordCount < 8 ? 500 : wordCount < 30 ? 800 : this.chatTokens
            const streamingOn =
                this._config?.streaming === true &&
                !!message?.channel &&
                !systemPrompt?.includes?.('[CONFIRMATION_REQUIRED]')
            const response = streamingOn
                ? await this._streamChat(messages, this.aiModel, adaptiveMax, this.temperature, message)
                : await this._groqCallWithFallbacks(messages, this.aiModel, adaptiveMax, this.temperature)

            if (!response) return null
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

    // Research response
    async ResearchResponse({ prompt, history, userId, username, displayName, message, systemPrompt }) {
        // Profile visual fast-path — bypass LLM, guarantee command execution ────
        const visualCmd = this._matchProfileVisual(prompt, userId, message)
        if (visualCmd) return { response: visualCmd }

        const bareQuestion =
            prompt.match(/\nUser's message:\s*([\s\S]+)$/)?.[1]?.trim() ??
            message.content.replace(new RegExp(`^<@!?${this.client.user.id}>\\s*`), '').trim()
        const routing = await this.needsResearch(bareQuestion)

        if (routing === 'nsfw')
            return {
                response:
                    "Oh sweetie, that's not something Mama's gonna go hunting for 🙅‍♀️💜 I keep things clean around here — you know the vibe. Ask me literally anything else and I got you!",
            }
        if (routing === 'dangerous')
            return {
                response:
                    "Hmm, hard pass babe 🚫 Not built for that kind of research. You good? Lmk if there's something else on your mind 💜",
            }

        if (routing === 'nosearch') {
            let clean = prompt
            for (const sig of NO_SEARCH_SIGNALS) clean = clean.replace(new RegExp(sig, 'gi'), '').trim()
            return {
                response: await this.generateResponse({
                    prompt: clean || prompt,
                    history,
                    userId,
                    username,
                    displayName,
                    message,
                    systemPrompt,
                }),
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
            })
            return { response, streamed: this._config?.streaming === true }
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

        const rawResearch = await this._callResearch(bareQuestion)

        let responsePayload = null
        if (!rawResearch) {
            // Silence the "shame" footer — if brain fallback works, say nothing about search failure
            responsePayload = await this.generateResponse({
                prompt,
                history,
                userId,
                username,
                displayName,
                message,
                systemPrompt,
            })
        } else {
            const { text: researchData, sources } = this._parseSources(rawResearch)
            const trimmed = researchData.slice(0, 4096)
            const persona =
                systemPrompt ||
                this.getUserPrompt(userId) ||
                this.instructions ||
                'You are Medusa, a vibrant AI assistant.'
            const userCtx = userId ? await this.getUserContext(userId, message) : ''
            const kSys = `[IDENTITY & PERSONA]\n${persona}\n\n[LIVE CONTEXT & AGENT DUTY]\n${userCtx}\n\n[FORMATTING]\nUse Discord markdown purposefully (**bold**, *italics*, \`code\`, > quotes).`
            const kPrompt = `Research data for this question:\n${'─'.repeat(36)}\n${trimmed}\n${'─'.repeat(36)}\n\nQuestion: ${bareQuestion}\n\nIMPORTANT: The research data above is live ground truth. Trust it completely. Adapt the answer STRICTLY to YOUR PERSONA. If the user asks for a visual or action based on this research, YOU MUST include the <<RUN_CMD>> tag.`
            const final = await this.generateResponse({
                prompt: kPrompt,
                history,
                userId,
                systemPrompt: kSys,
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

        // Always clean up the placeholder — even on total failure, don't leave it dangling.
        if (researchMsg) {
            try {
                await researchMsg.delete()
            } catch {}
        }

        return { response: responsePayload }
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
        if (content.toLowerCase().startsWith(this.prefix)) return { kind: 'ignore', reason: 'prefix_cmd' }

        const lower = content.toLowerCase()
        const botMentionRx = new RegExp(`^<@!?${this.client.user.id}>\\s+`)
        // True = user typed @Medusa as the first token of the message, intentionally summoning her.
        // This holds even when the message is ALSO a reply: Discord does NOT inject the reply
        // auto-ping into message.content, so a typed @ping at the start is always a real summon
        // (a bare reply with no typed mention won't match and stays silent in non-active channels).
        const startsWithExplicitPing = botMentionRx.test(content)
        // Mid-sentence mentions or reply-auto-pings don't count as an intentional summon.
        const mentioned = startsWithExplicitPing

        const isDM = message.channel.type === 1 && this.allowDM
        const inAlways = this.alwaysActiveCh.has(message.channel.id)

        let repliedToBot = false,
            repliedToOther = false
        const ref = message.reference?.resolved
        if (ref) {
            this.repliedMsgCache.set(message.id, ref)
            if (ref.author.id === this.client.user.id) repliedToBot = true
            else if (ref.author.id !== message.author.id) repliedToOther = true
        }

        const convKey = `${message.author.id}-${message.channel.id}`
        const inConv =
            this.activeConvs.has(convKey) && Date.now() - this.activeConvs.get(convKey) < this.convTimeout
        const hasTrig = this._triggerRegexes.some((rx) => rx.test(lower))

        let trigger = false
        // Always-active channels and DMs: mention/keyword/reply/conv all wake her.
        // Regular channels: ONLY an explicit @Medusa at the start of the message.
        // (No keyword match, no reply, no conv-continuation in regular channels.)
        if (isDM) trigger = hasTrig || mentioned || repliedToBot || inConv
        else if (inAlways && !repliedToOther) trigger = hasTrig || mentioned || repliedToBot || inConv
        else if (startsWithExplicitPing) trigger = true

        if (trigger) {
            this.activeConvs.set(convKey, Date.now())
            this.processedMsgIds.add(message.id)
            return {
                kind: 'trigger',
                reason: mentioned ? 'mention' : hasTrig ? 'keyword' : repliedToBot ? 'reply' : 'conv',
            }
        }
        return { kind: 'passive', reason: 'no_summon' }
    }

    // Deprecated alias — kept so any external caller doesn't break
    isTrigger(message) {
        return this.decideTrigger(message).kind === 'trigger'
    }
    async handleAIResponse(message, customPrompt = null, systemOverride = null) {
        let typingInterval
        try {
            message.channel.sendTyping().catch(() => {})
            typingInterval = setInterval(() => message.channel.sendTyping().catch(() => {}), 9000)

            const mem = this.getMem(message.guild)
            const userId = message.author.id
            const username = message.author.username
            const displayName = message.member?.displayName ?? username
            const content = customPrompt || message.content

            const oldUser = mem.getUser(userId)
            let proactiveSys = systemOverride
            if (oldUser && oldUser.last_interaction) {
                const daysSince = (Date.now() - new Date(oldUser.last_interaction).getTime()) / 86400000
                if (daysSince > 14) {
                    const welcome = `[PROACTIVE EVENT: The user hasn't spoken to you in over ${Math.floor(daysSince)} days! Welcome them back warmly and naturally.]`
                    proactiveSys = proactiveSys ? `${proactiveSys}\n\n${welcome}` : welcome
                }
            }

            mem.updateUser(userId, username, displayName)
            mem.analyzePersonality(userId, content)
            mem.updateInterests(userId, content)
            if (message.mentions?.users?.size) {
                for (const [mentionedId] of message.mentions.users) {
                    if (mentionedId !== this.client.user.id) mem.updateRelationship(userId, mentionedId)
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
            if (aliasMatch && !ALIAS_BLACKLIST.has(aliasMatch[1])) mem.setAlias(userId, aliasMatch[1], userId)

            const key = `${userId}-${message.channel.id}`
            if (!this.messageHistory.has(key)) this.messageHistory.set(key, [])

            let { url: imageUrl, isGif, label: imgLabel } = this._getImageFromMessage(message)
            if (!imageUrl && message.reference?.messageId) {
                const rr = await this._resolveReplyContext(message)
                if (rr?.hasImage) ({ url: imageUrl, isGif, label: imgLabel } = rr.imgData)
            }
            if (imageUrl) {
                const vSys = this.getUserPrompt(userId) || this.instructions || ''
                const { allImages } = this._getImageFromMessage(message)
                const vRes = await this._callVision(content, imageUrl, isGif, vSys, userId, allImages)
                if (vRes) {
                    mem.addConversation(userId, message.channel.id, content, vRes)
                    const hist = this.messageHistory.get(key)
                    hist.push({ role: 'user', content }, { role: 'assistant', content: vRes })
                    for (const chunk of this.splitResponse(vRes))
                        await this.secureReply(message, chunk, {
                            allowedMentions: { parse: this.replyPing ? ['users'] : [] },
                        })
                }
                return
            }

            const history = this.messageHistory.get(key).slice(-this.maxHistory)

            let finalContent = content
            const textFiles = await this._processTextAttachments(message)
            if (textFiles) finalContent += textFiles

            let { response, streamed } = await this.ResearchResponse({
                prompt: finalContent,
                history,
                userId,
                username,
                displayName,
                message,
                systemPrompt: proactiveSys,
            })
            if (!response) return
            if (streamed) {
                // Reply was already sent live; still run command parser so RUN_CMDs fire.
                // If the parser rewrote the response (e.g. into a ⚠️ Confirm prompt),
                // we need to overwrite the streamed message with the rewritten text so
                // the user sees the actual confirmation, not the raw LLM output.
                let execResult = await this._executeParsedCommands(response, message)
                const finalText = execResult.text || response
                if (finalText !== response) {
                    // Stream placeholder was the last bot message we sent — fetch and edit it
                    try {
                        const recent = await message.channel.messages.fetch({ limit: 5 })
                        const ours = recent.find(
                            (m) =>
                                m.author.id === this.client.user.id && m.reference?.messageId === message.id,
                        )
                        if (ours)
                            await ours
                                .edit({ content: this.finalSecurityCheck(finalText).slice(0, 2000) })
                                .catch(() => {})
                    } catch {}
                }
                const mem = this.getMem(message.guild)
                if (!finalText.startsWith('⚠️ Confirm'))
                    mem.addConversation(userId, message.channel.id, finalContent, finalText)
                return
            }

            let execResult = await this._executeParsedCommands(response, message)
            response = execResult.text
            const extraEmbeds = execResult.embeds || []

            if (!response && !extraEmbeds.length) return

            // Never store confirmation prompts — they poison future context
            if (!response.startsWith('⚠️ Confirm')) {
                mem.addConversation(
                    userId,
                    message.channel.id,
                    finalContent,
                    response || '*(silently executed system tool)*',
                )
            }
            let hist = this.messageHistory.get(key)
            if (!hist) {
                hist = []
                this.messageHistory.set(key, hist)
            }
            hist.push({ role: 'user', content: finalContent })
            if (!response.startsWith('⚠️ Confirm')) {
                hist.push({ role: 'assistant', content: response || '*(silently executed system tool)*' })
            }
            const media = await this._pickExpressiveMedia(response, message)
            const chunks = this.splitResponse(response || '')
            if (!chunks.length || (chunks.length === 1 && !chunks[0])) {
                if (extraEmbeds.length)
                    await this.secureReply(message, '', { embeds: extraEmbeds.slice(0, 10) })
            } else {
                for (let i = 0; i < Math.min(chunks.length, 4); i++) {
                    const isLast = i === Math.min(chunks.length, 4) - 1 || i === chunks.length - 1
                    await this.secureReply(message, chunks[i], {
                        allowedMentions: { parse: this.replyPing ? ['users'] : [] },
                        embeds: isLast ? extraEmbeds.slice(0, 10) : [],
                    })
                }
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
        } finally {
            if (typingInterval) clearInterval(typingInterval)
        }
    }

    async processAIMessage(message) {
        if (this.paused || this.shouldIgnore(message)) return
        if (!this.isTrigger(message)) return
        const guildId = message.guild?.id ?? '0'
        if (guildId !== '0' && this.aiAllowedGuilds.size > 0 && !this.aiAllowedGuilds.has(guildId)) return

        const userId = message.author.id
        const isStaff = !!message.member?.permissions?.has(PermissionFlagsBits.ModerateMembers)
        const isOwner = String(userId) === String(this.ownerId)
        const gate = this.client.heart?.rateLimiter?.check(userId, { isStaff, isOwner })
        if (gate && !gate.ok) return
        const now = Date.now()

        // Block new AI responses while a destructive confirmation is pending for this user
        if ([...this._pendingConfirms.keys()].some((k) => k.startsWith(`${userId}:`))) return

        // Spam protection
        let counts = this.userMsgCounts.get(userId) ?? []
        counts = counts.filter((t) => now - t < this.spamWindow)
        counts.push(now)
        this.userMsgCounts.set(userId, counts)
        if (this.userCooldowns.has(userId) && now < this.userCooldowns.get(userId)) return
        if (counts.length > this.spamThreshold) {
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

    async onMessage(message) {
        if (message.author.bot || message.author.id === this.client.user.id) return
        if (this.paused) return
        if (!this.allowDM && message.channel.type === 1) return
        if (message.guild && this.allowedGuilds.size && !this.allowedGuilds.has(message.guild.id)) return
        if (this.shouldIgnore(message)) return
        if (this.triggeredMsgs.has(message.id)) return
        // Allow messages with no text if they carry images/attachments — vision pipeline needs them
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

        // Confirmation replies (non-reply-to-bot path — bare "yes"/"no" in channel)
        const userHasPending = [...this._pendingConfirms.keys()].some((k) =>
            k.startsWith(`${message.author.id}:`),
        )
        if (userHasPending && (lower === 'yes' || lower === 'no')) {
            const now = Date.now()
            for (const [key, val] of this._pendingConfirms) {
                if (now - val.ts > 30_000) {
                    this._pendingConfirms.delete(key)
                    continue
                }
                if (!key.startsWith(`${message.author.id}:`)) continue
                this._pendingConfirms.delete(key)
                if (lower === 'no') {
                    await message.react('❌').catch(() => {})
                    return
                }
                const [, cmdName] = key.split(':')
                // Full args are stored in the value, not the key (key is sanitized for lookup)
                const args = (val.args ?? '').split(/\s+/).filter(Boolean)
                const handler = this.client.commands?.get(cmdName)
                if (handler) {
                    try {
                        await handler(message, args)
                        await message.react('✅').catch(() => {})
                        console.log(
                            `[AI] Confirmed and executed '${cmdName}' args='${val.args}' by ${message.author.id}`,
                        )
                    } catch (e) {
                        console.error('[AI] Confirmed exec error:', e)
                    }
                }
                return
            }
            // User had a pending confirm but it expired — absorb yes/no, don't send to AI
            return
        }

        // Prefix commands take precedence — "med, snaek" is a prefix attempt, not an AI trigger.
        if (lower.startsWith(this.prefix)) return

        const replyResolved = await this._resolveReplyContext(message)
        const repliedTo = replyResolved?.ref?.author ?? null
        const isReplyToBot = repliedTo?.id === this.client.user.id

        // If replying to a bot message with yes/no, always treat as a confirmation attempt.
        // If no active confirm found, absorb silently — never send to AI.
        if (isReplyToBot && (lower === 'yes' || lower === 'no')) {
            const now = Date.now()
            for (const [key, val] of this._pendingConfirms) {
                if (now - val.ts > 30_000) {
                    this._pendingConfirms.delete(key)
                    continue
                }
                if (!key.startsWith(`${message.author.id}:`)) continue
                this._pendingConfirms.delete(key)
                if (lower === 'no') {
                    await message.react('❌').catch(() => {})
                    return
                }
                const [, cmdName] = key.split(':')
                const args = (val.args ?? '').split(/\s+/).filter(Boolean)
                const handler = this.client.commands?.get(cmdName)
                if (handler) {
                    try {
                        await handler(message, args)
                        await message.react('✅').catch(() => {})
                        console.log(
                            `[AI] Confirmed and executed '${cmdName}' args='${val.args}' by ${message.author.id}`,
                        )
                    } catch (e) {
                        console.error('[AI] Confirmed exec error:', e)
                    }
                }
                return
            }
            return // Reply-to-bot yes/no with no active confirm — absorb, don't send to AI
        }
        let replyCtx = null
        if (replyResolved) {
            const { label, textContext, hasText } = replyResolved
            // Prefix makes it unambiguous to the model that this is metadata, not user content.
            // Also: truncate aggressively so we don't poison the reply when the original was long.
            const NL = String.fromCharCode(10)
            const ctxBody = hasText ? textContext.slice(0, 300).split(NL).join(' ') : '(empty)'
            replyCtx =
                `[INTERNAL CONTEXT — do NOT quote, do NOT repeat, do NOT format as a user message.` +
                ` The user is replying to ${label}: "${ctxBody}"]`
        }

        const isReplyToMe = repliedTo?.id === this.client.user.id

        const _botMentionRx = new RegExp(`^<@!?${this.client.user.id}>\\s+`)
        // A typed @ping at the start counts as a summon even if the message is also a reply to her.
        // (Discord doesn't put the reply auto-ping into raw content, so a bare reply still won't match.)
        const startsWithExplicitPing = _botMentionRx.test(raw)
        const hasTrig = this._triggerRegexes.some((rx) => rx.test(lower))
        const isMention = startsWithExplicitPing
        const isAlways = this.alwaysActiveCh.has(message.channel.id)

        let trigger = false
        let prompt = raw

        if (isAlways && (isMention || isReplyToMe || hasTrig)) {
            trigger = true
            if (replyCtx)
                prompt = `${replyCtx}

${raw}`
        } else if (isReplyToMe && hasMedia) {
            // Regular channel reply-to-bot with image attached — treat as explicit "look at this"
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
            if (guildId !== '0' && this.aiAllowedGuilds.size > 0 && !this.aiAllowedGuilds.has(guildId)) return

            if ([...this._pendingConfirms.keys()].some((k) => k.startsWith(`${message.author.id}:`))) return

            this.triggeredMsgs.add(message.id)
            this.processedMsgIds.add(message.id)

            try {
                const userId = message.author.id
                const ctx = await this.getUserContext(userId, message)
                const userSys =
                    this.getUserPrompt(userId) ||
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
            const types = ['roast', 'dark_humor', 'fun_fact', 'observation', 'philosophical']
            const weights = [10, 1, 1, 1, 1]
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
            if (content) await ch.send({ content: this.finalSecurityCheck(content) })
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
                SELECT user_id, message_content FROM conversations
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
            // Strip any URLs the LLM hallucinated from the quote context — prevents invite/link injection
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
        this.repliedMsgCache.clear()
        if (this.responseTimes.length > 100) this.responseTimes = this.responseTimes.slice(-50)
        for (const [k, q] of this.msgQueues) if (!q.length) this.msgQueues.delete(k)
        // Prune spamProtect
        for (const [uid, ts] of this.spamProtect) {
            const fresh = ts.filter((t) => now - t < 30_000)
            if (!fresh.length) this.spamProtect.delete(uid)
            else this.spamProtect.set(uid, fresh)
        }
        // Cleanup old DB entries
        for (const mem of [this.globalMem, ...this.isolatedMems.values()]) {
            try {
                mem.cleanupOld(PERF.maintenance.retentionDays)
            } catch {}
        }
    }
}
