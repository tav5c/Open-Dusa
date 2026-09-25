// Medusa AI, extension entry point. The engine lives in extensions/ai/ as a
// layered class chain (providers -> research -> vision -> commands -> output -> chat);
// this file wires it into the client and owns slash/prefix registration.
import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType,
    EmbedBuilder,
    MessageFlags,
    PermissionFlagsBits,
    SlashCommandBuilder,
} from 'discord.js'
import { existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { loadPerformance } from './performance.js'
import { readConfigRaw, saveRuntime, setConfigGuild, writeConfigRaw } from './config.js'
import { AIChatManager } from './ai/chat.js'
import { AIMemoryManager } from './ai/memory.js'
import { deleteUserTimezone, getSavedTimezone, setTzStoreEnabled } from './timezones.js'
import { forceEphemeral, guildBlockedReason } from './utils.js'
import { containsDisallowedHate, safetyRefusal } from './ai/safety.js'
import { logAction } from './moderation.js'

export { _undiciAgent } from './ai/providers.js'

// Shared recall formatting: prefix `recall` and `/recall` both use it. Returns
// the reply text (auto-delete + privacy notes included where they apply).
async function buildRecallText(ai, guild, authorId, isMod, query, { ephemeralHint = false } = {}) {
    if (!query) return '❌ Give me a name to recall.'
    if (!guild) return '❌ Server memory only works in a server.'
    const id = await ai._resolveMemberId({ guild, reference: null }, query)
    if (!id) return `❌ No member matching \`${String(query).slice(0, 60)}\` found.`
    // Privacy: anyone may recall themselves; recalling others is mods (+owner).
    if (String(authorId) !== String(id) && !isMod)
        return '🔑 Recall of others is mods-only — but you can recall yourself.'
    const mem = ai.getMem(guild)
    const user = mem.getUser(id)
    if (!user) return `💭 Nothing stored on <@${id}> yet — they haven't chatted with me.`
    const ints = mem.getInterests(id, 5)
    const pers = mem.getPersonality(id)
    const summary = mem.getSummary(id)
    const lines = [
        `**Recall — ${user.display_name || user.username}** (<@${id}>)`,
        `Conversations: \`${user.conversation_count ?? 0}\` • Last seen: \`${String(user.last_interaction ?? 'never').slice(0, 10)}\``,
    ]
    if (ints.length) lines.push(`Interests: ${ints.map((r) => `${r.topic}(${r.frequency})`).join(', ')}`)
    if (pers?.traits) lines.push(`Vibe: ${pers.traits}`)
    if (summary) lines.push(`Notes: ${String(summary).slice(0, 500)}`)
    // Multi-word queries ("adi mute threats") also pull matching quotes via
    // full-text search. Single names skip it: one's own messages rarely
    // contain one's name, so it would only add noise.
    const qwords = String(query ?? '')
        .replace(/<@!?\d+>/g, ' ')
        .split(/[^a-zA-Z0-9]+/)
        .filter((w) => w.length >= 3)
    if (qwords.length > 1) {
        const hits = mem.searchConversations(qwords.join(' '), id, 2)
        for (const h of hits) {
            lines.push(`> "${String(h.message_content ?? '').slice(0, 140)}"`)
        }
    }
    if (!ephemeralHint) lines.push('-# (auto-deletes in 60s)')
    return lines.join('\n')
}

const PERF = loadPerformance()

// Register function (called from index.js)
let OWNER_ID = null
const ownerOnly = (fn) => async (msg, args) => {
    if (String(msg.author.id) !== String(OWNER_ID)) return
    await fn(msg, args)
}
export async function registerAI(client, db, config) {
    OWNER_ID = config.ownerId
    // Blank ownerName falls back to the cached owner user (one fetch at
    // boot, then cache) instead of shipping empty creator-lore lines.
    // An explicit non-blank name, including the 'My Developer' default,
    // is left alone.
    if (!String(config.ownerName ?? '').trim()) {
        try {
            const u =
                client.users.cache.get(String(config.ownerId)) ??
                (await client.users.fetch(String(config.ownerId)).catch(() => null))
            config.ownerName = u?.displayName ?? u?.username ?? 'My Developer'
        } catch {
            config.ownerName = 'My Developer'
        }
    }
    // NOTE: sqlite driver init lives ONLY in db.js::loadSqlite (cipher build,
    // probed at index.js boot). A duplicate plain-build init used to live here
    // behind `if (!globalThis._sqlite3)` — order-dependent, and losing the race
    // silently disabled encryption. If the driver is missing, memory.js already
    // degrades to stubDb; nothing here needs to init it.
    try {
        const dataDir = 'data/ai'
        const sentinel = join(dataDir, '.migrated-v1')
        if (existsSync(dataDir) && !existsSync(sentinel)) {
            const folderPattern = /^(.+) - (\d{17,20})$/
            // Group folders by guild ID
            const byGuild = new Map()
            for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
                if (!entry.isDirectory()) continue
                const match = entry.name.match(folderPattern)
                if (!match) {
                    // Check for bare-ID folders from previous revision
                    if (/^\d{17,20}$/.test(entry.name)) {
                        const arr = byGuild.get(entry.name) || []
                        arr.push({
                            path: join(dataDir, entry.name),
                            name: entry.name,
                            guildId: entry.name,
                            isBareId: true,
                        })
                        byGuild.set(entry.name, arr)
                    }
                    continue
                }
                const [, , guildId] = match
                const arr = byGuild.get(guildId) || []
                arr.push({ path: join(dataDir, entry.name), name: entry.name, guildId })
                byGuild.set(guildId, arr)
            }

            for (const [guildId, folders] of byGuild) {
                if (folders.length <= 1 && !folders[0]?.isBareId) continue
                // Sort by DB size descending, keep the largest as the primary
                folders.sort((a, b) => {
                    const aDb = join(a.path, 'memory.db')
                    const bDb = join(b.path, 'memory.db')
                    const aSize = existsSync(aDb) ? statSync(aDb).size : 0
                    const bSize = existsSync(bDb) ? statSync(bDb).size : 0
                    return bSize - aSize
                })
                const primary = folders[0]
                const others = folders.slice(1)

                if (!others.length) continue // only bare-ID folder, will be renamed by _resolveAndSync at runtime

                const primaryDb = join(primary.path, 'memory.db')
                if (!existsSync(primaryDb)) continue

                for (const other of others) {
                    const otherDb = join(other.path, 'memory.db')
                    if (!existsSync(otherDb)) continue
                    try {
                        const { default: Database } = globalThis._sqlite3
                        const dst = new Database(primaryDb)
                        dst.exec(`ATTACH DATABASE '${otherDb.replace(/'/g, "''")}' AS src`)
                        dst.exec(`
                            INSERT OR IGNORE INTO conversations (user_id, channel_id, message_content, ai_response, timestamp)
                                SELECT user_id, channel_id, message_content, ai_response, timestamp FROM src.conversations;
                            INSERT OR IGNORE INTO users (user_id, username, display_name, conversation_count, last_interaction, created_at, updated_at)
                                SELECT user_id, username, display_name, conversation_count, last_interaction, created_at, updated_at FROM src.users
                                WHERE user_id NOT IN (SELECT user_id FROM users);
                            INSERT OR IGNORE INTO interests (user_id, topic, frequency, last_mentioned)
                                SELECT user_id, topic, frequency, last_mentioned FROM src.interests;
                            INSERT OR IGNORE INTO personality (user_id, traits, preferences, communication_style, updated_at)
                                SELECT user_id, traits, preferences, communication_style, updated_at FROM src.personality
                                WHERE user_id NOT IN (SELECT user_id FROM personality);
                        `)
                        dst.exec('DETACH DATABASE src')
                        dst.close()
                        console.log(`[AI] Merged "${other.name}" -> "${primary.name}"`)
                        const { rmSync } = await import('fs')
                        rmSync(other.path, { recursive: true, force: true })
                    } catch (e) {
                        console.warn(`[AI] Could not merge "${other.name}":`, e.message)
                    }
                }
            }
        }
    } catch (e) {
        console.warn('[AI] Folder migration scan failed:', e.message)
    }

    const _passiveBuf = new Map()
    const _PASSIVE_MAX = PERF.ai.passiveBufferMax
    const _PASSIVE_CHANNELS_MAX = PERF.ai.passiveBufferChannelsMax
    globalThis._aiPassiveBuf = _passiveBuf

    const ai = new AIChatManager(client, db, config)
    client.aiCog = ai
    ai._passiveBuf = _passiveBuf // wire buffer so getUserContext() can inject live channel activity
    // Blocked servers (paused/out-of-scope): generation-gated commands
    // refuse, and every other reply on the interaction goes ephemeral —
    // nothing the bot says there is publicly visible. Privacy commands
    // (/memory, /forgetme, /recall) and moderation stay available.
    const aiBlockedReply = (blocked) =>
        blocked === 'paused'
            ? '💤 AI is paused in this server — an admin can resume it with `/ai-pause`.'
            : "🔇 AI isn't active in this server."
    // Host amnesia covers the AI side of timezones (no model reads, no
    // auto-learn writes). Manual /tz commands keep working on purpose.
    setTzStoreEnabled(config.memory !== false)

    client.on('messageCreate', async (msg) => {
        try {
            await ai.onMessage(msg)
        } catch (e) {
            console.error('[AI] Fatal onMessage error:', e)
        }
    })

    client.on('guildMemberAdd', (member) => {
        if (!member.guild) return
        if (ai.isMemOff(member.id)) return
        const mem = ai.getMem(member.guild)
        mem.updateUser(member.id, member.user.username, member.displayName)
    })

    client.on('messageDelete', (msg) => {
        ai.processedMsgIds?.delete?.(msg.id)
        ai.triggeredMsgs?.delete?.(msg.id)
    })

    client.on('messageCreate', (msg) => {
        if (msg.author.bot) return
        if (ai.debugMode) return // debug mode: no passive buffering anywhere
        if (ai.isMemOff(msg.author.id)) return // memory-off: leave no room-context trace
        if (!msg.guild) return
        if (!msg.content?.trim()) return
        if (msg.content.length < 3) return
        if (containsDisallowedHate(msg.content)) return
        const everyonePerms = msg.channel.permissionsFor(msg.guild.roles.everyone)
        if (!everyonePerms?.has('ViewChannel')) return

        if (ai.allowedGuilds.size && !ai.allowedGuilds.has(msg.guild.id)) return
        if (ai.pausedGuilds.has(msg.guild.id)) return // paused: no room context accrues either

        const entry = {
            userId: msg.author.id,
            displayName: msg.member?.displayName ?? msg.author.username,
            content: msg.content.slice(0, 200),
            ts: Date.now(),
        }
        let buf = _passiveBuf.get(msg.channel.id)
        if (!buf) {
            if (_passiveBuf.size >= _PASSIVE_CHANNELS_MAX) {
                const firstKey = _passiveBuf.keys().next().value
                if (firstKey) _passiveBuf.delete(firstKey)
            }
            buf = []
            _passiveBuf.set(msg.channel.id, buf)
        }
        buf.push(entry)
        if (buf.length > _PASSIVE_MAX) buf.shift()
    })

    // Auto-extract server lore every 30 min, throttled to once per 2h per guild
    const _loreExtractedAt = new Map()
    setInterval(() => {
        const now = Date.now()
        const staleTime = now - 3600_000 // 1h stale
        const minGap = 2 * 3600_000 // 2h per-guild throttle
        for (const [channelId, buf] of _passiveBuf) {
            if (!buf.length || buf[buf.length - 1].ts < staleTime) {
                _passiveBuf.delete(channelId)
                continue
            }
            if (buf.length < 5) continue
            const ch = client.channels.cache.get(channelId)
            if (!ch?.guild) continue
            if (ai.pausedGuilds.has(ch.guild.id)) continue
            const last = _loreExtractedAt.get(ch.guild.id) ?? 0
            if (now - last < minGap) continue
            _loreExtractedAt.set(ch.guild.id, now)
            try {
                ai.getMem(ch.guild).autoExtractLore(buf)
            } catch {}
        }
    }, 30 * 60_000).unref()
    // interaction listeners (AI-owned slash commands)
    client.on('interactionCreate', async (interaction) => {
        // Blocked servers hear nothing public: force every reply on this
        // interaction ephemeral before any handler runs.
        if (guildBlockedReason(client, interaction.guild)) forceEphemeral(interaction)
        // Modal submit for the confirm-reason button (customId mcfm-rsn:<cmd>:<target>).
        // Refreshes the pending args and the confirm embed in place.
        if (interaction.isModalSubmit?.() && interaction.customId?.startsWith('mcfm-rsn:')) {
            try {
                // NOTE: modal IDs are mcfm-rsn:<cmd>:<target> (tag is one segment),
                // unlike button IDs mcfm:<yes|no|rsn>:<cmd>:<target>.
                const [, cmd, ...tparts] = String(interaction.customId).split(':')
                const target = tparts.join(':')
                const key = `${interaction.user.id}:${cmd}:${target}`
                const val = ai._pendingConfirms.get(key)
                if (!val || Date.now() - val.ts > 30_000) {
                    return interaction.reply({
                        content: '⌛ Expired — ask again if you still want it.',
                        flags: MessageFlags.Ephemeral,
                    })
                }
                const reason = interaction.fields.getTextInputValue('reason')?.slice(0, 300) ?? ''
                // Preserve a leading duration token for mute ("10m"), replace the rest.
                const parts = (val.args ?? '').split(/\s+/).filter(Boolean)
                const keepDur = cmd === 'mute' && parts[1] && /^\d/.test(parts[1]) ? ` ${parts[1]}` : ''
                val.args = `${parts[0] ?? ''}${keepDur} ${reason}`.trim()
                val.ts = Date.now()
                await interaction.update({
                    embeds: [ai.buildConfirmEmbed(cmd, target, reason, interaction.user.id)],
                    components: [ai.buildConfirmRow(cmd, target)],
                })
            } catch (e) {
                console.error('[AI] Confirm modal error:', e)
            }
            return
        }
        if (!interaction.isChatInputCommand()) return
        const { commandName } = interaction
        const uid = interaction.user.id
        const isOwner = uid === OWNER_ID

        // /medusa (Quick Agent), stateless, DMs and group chats only
        if (commandName === 'medusa') {
            if (interaction.inGuild()) {
                return interaction.reply({
                    content: '💜 /medusa only works in DMs and group chats.',
                    flags: MessageFlags.Ephemeral,
                })
            }
            const prompt = interaction.options.getString('prompt')
            const searchArg = interaction.options.getString('search') ?? 'auto'
            const forceSearch = searchArg === 'on'
            const skipSearch = searchArg === 'off'
            const isPrivate = (interaction.options.getString('privacy') ?? 'off') === 'on'
            const flags = isPrivate ? MessageFlags.Ephemeral : undefined

            await interaction.deferReply(flags ? { flags } : {})
            // Master switch wins over explicit On: answer from knowledge
            // with a notice instead of silently going stale.
            const searchOffNote =
                forceSearch && ai._searchOff?.()
                    ? '🔍 Web research is disabled on this host — answering from knowledge.\n\n'
                    : ''

            const isStaff = !!interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)
            const gate = client.heart?.rateLimiter?.check(uid, { isStaff, isOwner })
            if (gate && !gate.ok) {
                return interaction.editReply({
                    content: '⏳ Too many requests. Wait a few seconds and try again.',
                })
            }

            try {
                const response = await ai.generateStatelessResponse({
                    prompt,
                    forceSearch,
                    skipResearch: skipSearch,
                    guildId: interaction.guild?.id ?? null,
                    isOwner,
                    userId: interaction.user.id,
                })
                if (!response)
                    return interaction.editReply({ content: '✗ All providers failed. Try again shortly.' })

                const safe = ai.finalSecurityCheck(response, interaction)
                const chunks = ai.splitResponse(safe, 1900)
                if (searchOffNote && chunks.length) chunks[0] = searchOffNote + chunks[0]
                await interaction.editReply({ content: chunks[0] || '...' })
                for (let i = 1; i < Math.min(chunks.length, 4); i++) {
                    await interaction.followUp({ content: chunks[i], ...(flags ? { flags } : {}) })
                }
            } catch (e) {
                console.error('[AI] /medusa error:', e)
                try {
                    await interaction.editReply({ content: '✗ Failed to generate response.' })
                } catch {}
            }
            return
        }

        // /ask — server-only quick answer with light memory. Stateless model
        // call (never streams: instant by design), persona-aware, writes the
        // exchange unless the user turned memory off globally.
        if (commandName === 'ask') {
            if (!interaction.guild) {
                return interaction.reply({
                    content: '💜 /ask is server-only. Use `/medusa` in DMs.',
                    flags: MessageFlags.Ephemeral,
                })
            }
            {
                const blocked = guildBlockedReason(client, interaction.guild)
                if (blocked)
                    return interaction.reply({
                        content: aiBlockedReply(blocked),
                        flags: MessageFlags.Ephemeral,
                    })
            }
            const prompt = interaction.options.getString('prompt')
            const researchArg = interaction.options.getString('research') ?? 'auto'
            const isPrivate = (interaction.options.getString('privacy') ?? 'off') === 'on'
            const flags = isPrivate ? MessageFlags.Ephemeral : undefined
            // Same master-switch notice as /medusa below.
            const searchOffNote =
                researchArg === 'on' && ai._searchOff?.()
                    ? '🔍 Web research is disabled on this host — answering from knowledge.\n\n'
                    : ''
            await interaction.deferReply(flags ? { flags } : {})

            const uid = interaction.user.id
            const isOwner = String(uid) === String(OWNER_ID)
            const isStaff = !!interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)
            const gate = client.heart?.rateLimiter?.check(uid, { isStaff, isOwner })
            if (gate && !gate.ok) {
                return interaction.editReply({
                    content: '⏳ Too many requests. Wait a few seconds and try again.',
                })
            }

            try {
                const memOff = ai.isMemOff(uid)
                const mem = ai.getMem(interaction.guild)
                let userCtx = ''
                if (!memOff) {
                    const u = mem.getUser(uid)
                    const summary = mem.getSummary(uid)
                    const bits = []
                    if (u?.display_name || u?.username)
                        bits.push(`Talking to ${u.display_name || u.username}`)
                    if (summary) bits.push(`What you remember about them: ${String(summary).slice(0, 600)}`)
                    userCtx = bits.join('\n')
                }
                const response = await ai.generateStatelessResponse({
                    prompt,
                    forceSearch: researchArg === 'on',
                    skipResearch: researchArg === 'off',
                    systemExtra: `${(() => {
                        const custom = ai.customPrompts?.[uid]
                        if (typeof custom === 'string' && custom) return `[USER PERSONA] ${custom}\n\n`
                        const server = ai.serverPrompts?.[interaction.guild.id]
                        if (typeof server === 'string' && server) return `[SERVER PERSONA] ${server}\n\n`
                        return ''
                    })()}QUICKIE: one fast, precise, well-formatted answer. Lead with the answer, minimal throat-clearing, markdown only where it helps.`,
                    userCtx,
                    guildId: interaction.guild?.id ?? null,
                    isOwner,
                    userId: interaction.user.id,
                })
                if (!response)
                    return interaction.editReply({ content: '✗ All providers failed. Try again shortly.' })
                if (!memOff) {
                    try {
                        mem.updateUser(uid, interaction.user.username, interaction.user.username)
                        const chId = interaction.channel?.id ?? 'ask'
                        mem.addConversation(uid, chId, prompt.slice(0, 2000), String(response).slice(0, 2000))
                    } catch {}
                }
                const safe = ai.finalSecurityCheck(response, interaction)
                const chunks = ai.splitResponse(safe, 1900)
                if (searchOffNote && chunks.length) chunks[0] = searchOffNote + chunks[0]
                await interaction.editReply({ content: chunks[0] || '...' })
                for (let i = 1; i < Math.min(chunks.length, 4); i++) {
                    await interaction.followUp({ content: chunks[i], ...(flags ? { flags } : {}) })
                }
            } catch (e) {
                console.error('[AI] /ask error:', e)
                try {
                    await interaction.editReply({ content: '✗ Failed to generate response.' })
                } catch {}
            }
            return
        }

        // /summarize

        if (commandName === 'summarize') {
            {
                const blocked = interaction.guild ? guildBlockedReason(client, interaction.guild) : null
                if (blocked)
                    return interaction.reply({
                        content: aiBlockedReply(blocked),
                        flags: MessageFlags.Ephemeral,
                    })
            }
            const BETWEEN = 15 * 60_000,
                WINDOW = 12 * 3_600_000,
                MAX = 3
            const now = Date.now()
            if (!isOwner) {
                const uses = (ai.summarizeCDs.get(uid) ?? []).filter((t) => now - t < WINDOW)
                ai.summarizeCDs.set(uid, uses)
                if (uses.length) {
                    const sincelast = now - uses[uses.length - 1]
                    if (sincelast < BETWEEN) {
                        const rem = BETWEEN - sincelast
                        const m = Math.floor(rem / 60000),
                            s = Math.floor((rem % 60000) / 1000)
                        return interaction.reply({
                            content: `⏳ Cooldown, wait **${m}m ${s}s** before summarizing again.`,
                            flags: MessageFlags.Ephemeral,
                        })
                    }
                }
                if (uses.length >= MAX) {
                    const resets = WINDOW - (now - uses[0])
                    return interaction.reply({
                        content: `📋 You've used \`/summarize\` **${MAX}x** in the last 12h. Resets in **${Math.floor(resets / 3600000)}h ${Math.floor((resets % 3600000) / 60000)}m**.`,
                        flags: MessageFlags.Ephemeral,
                    })
                }
            }

            await interaction.deferReply()
            const startRaw = interaction.options.getString('start-from')
            const startFrom = startRaw ? (startRaw.match(/(\d{15,20})\s*$/)?.[1] ?? startRaw) : null
            let startMsg = null
            if (startFrom) {
                try {
                    startMsg = await interaction.channel.messages.fetch(startFrom)
                } catch {
                    return interaction.editReply({ content: '❌ Invalid message ID or message not found.' })
                }
            }

            const messages = []
            if (startMsg) {
                // Must use [...values()] and sort oldest-first (fetch with `after` returns newest-first).
                const fetched = await interaction.channel.messages.fetch({ limit: 100, after: startMsg.id })
                const sorted = [...fetched.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp)
                for (const m of sorted) {
                    if (!m.author.bot && m.content.trim() && !ai.isMemOff(m.author.id)) {
                        messages.push({
                            author: m.member?.displayName ?? m.author.username,
                            content: m.content,
                            ts: m.createdAt,
                        })
                        if (messages.length >= 100) break
                    }
                }
                if (!startMsg.author.bot && startMsg.content.trim() && !ai.isMemOff(startMsg.author.id))
                    messages.unshift({
                        author: startMsg.member?.displayName ?? startMsg.author.username,
                        content: startMsg.content,
                        ts: startMsg.createdAt,
                    })
            } else {
                // discord caps a single fetch at 100, walk two pages so busy channels still fill up
                let cursor = null
                for (let page = 0; page < 2 && messages.length < 100; page++) {
                    const opts = { limit: 100 }
                    if (cursor) opts.before = cursor
                    const fetched = await interaction.channel.messages.fetch(opts)
                    if (!fetched.size) break
                    for (const [, m] of fetched) {
                        cursor = m.id
                        if (!m.author.bot && m.content.trim() && !ai.isMemOff(m.author.id)) {
                            messages.push({
                                author: m.member?.displayName ?? m.author.username,
                                content: m.content,
                                ts: m.createdAt,
                            })
                            if (messages.length >= 100) break
                        }
                    }
                    if (fetched.size < 100) break
                }
                messages.reverse()
            }
            if (!messages.length)
                return interaction.editReply({ content: '❌ No messages found to summarize.' })

            const participants = [...new Set(messages.map((m) => m.author))]
            const convText = messages
                .slice(-75)
                .map((m) => `**${m.author}**: ${m.content}`)
                .join('\n')
            const summaryPrompt = `Analyze this conversation and provide a clear, well-structured summary.\n**Participants:** '${participants.join("', '")}'\n**Formatting:** **bold** for key points, bullet points for key events.\n**Include:** main topics, key participants, decisions/outcomes, conflicts/resolutions, flow of discussion.\nEnd with "> **📋 TL;DR:**" (2-3 lines).\nConversation (${messages.length} messages):\n${convText}`
            const summary = await ai.generateResponse({
                prompt: summaryPrompt,
                systemPrompt:
                    'You are Medusa, an expert conversation analyst. Provide concise, clear summaries. Use minimal blank lines, structured bullets, and avoid fluff.',
            })
            if (!summary)
                return interaction.editReply({ content: '❌ Failed to generate summary. Please try again.' })

            const first = messages[0].ts,
                last = messages[messages.length - 1].ts
            const header = `> 📋 **Conversation Summary**${startMsg ? ` (from message \`${startMsg.id}\`)` : ` (last ${messages.length} messages)`}\n> \`🕒| ${first.toISOString().slice(0, 16)}\` **__->__** \`${last.toISOString().slice(0, 16)} UTC\`\n> 👥| **${participants.length} users**\n${'─'.repeat(40)}`
            const full = `${header}\n${summary}`.slice(0, 2000)
            await interaction.editReply({ content: full })

            if (!isOwner) {
                const uses = ai.summarizeCDs.get(uid) ?? []
                uses.push(now)
                ai.summarizeCDs.set(uid, uses)
            }
            return
        }

        // /memory
        if (commandName === 'memory') {
            const userId = interaction.user.id
            if (ai._memoryOff === true) {
                return interaction.reply({
                    content:
                        '🔒 Memory is disabled on this host — nothing is stored or fetched for anyone. Prompts, modes, and `/forgetme` still work.',
                    flags: MessageFlags.Ephemeral,
                })
            }
            const modeArg = interaction.options.getString('mode')
            if (modeArg === 'on' || modeArg === 'off') {
                ai.userMemory[String(userId)] = modeArg === 'on'
                ai._scheduleUsersSave()
                if (modeArg === 'off') {
                    // RAM purge so off means off immediately: drop this
                    // session's short-term history, cached context, and any
                    // room-buffer entries. DB rows stay (by design) until
                    // /forgetme — the reply below says exactly that.
                    try {
                        for (const k of [...ai.messageHistory.keys()])
                            if (k.startsWith(`${userId}-`)) ai.messageHistory.delete(k)
                        ai._invalidateUserCache?.(String(userId))
                        for (const [chId, buf] of ai._passiveBuf ?? []) {
                            const kept = buf.filter((e) => e.userId !== String(userId))
                            if (kept.length !== buf.length) ai._passiveBuf.set(chId, kept)
                        }
                    } catch {}
                }
                return interaction.reply({
                    content:
                        modeArg === 'on'
                            ? '✅ Memory **on** — I\u2019ll remember our chats again.'
                            : '✅ Memory **off** — nothing stored, nothing fetched, and you\u2019re left out of room context. Existing data stays put; `/forgetme` wipes it if you want that too.',
                    flags: MessageFlags.Ephemeral,
                })
            }
            const mem = ai.getMem(interaction.guild)
            const user = mem.getUser(userId)
            const ints = mem.getInterests(userId, 10)
            const pers = mem.getPersonality(userId)
            const summary = mem.getSummary(userId)
            const scope = mem === ai.globalMem ? '🌐 shared across servers' : '🔒 isolated to this server'
            const embed = new EmbedBuilder()
                .setTitle(`🧠 Medusa's Memory, ${interaction.user.displayName}`)
                .setColor(0x7f77dd)
                .setThumbnail(interaction.user.displayAvatarURL({ size: 128 }))
                .setDescription(`Memory scope: ${scope}`)
            if (user) {
                const count = user.conversation_count ?? 0
                const level =
                    count > 200
                        ? '💜 inner circle'
                        : count > 50
                          ? '🔥 active'
                          : count > 10
                            ? '👋 regular'
                            : '🌱 new'
                embed.addFields({
                    name: '📊 Profile',
                    value: `Conversations: \`${count}\` (${level})\nLast seen: \`${String(user.last_interaction ?? 'never').slice(0, 10)}\``,
                    inline: false,
                })
            } else {
                embed.addFields({
                    name: '📊 Profile',
                    value: 'No profile stored yet, say hi!',
                    inline: false,
                })
            }
            if (ints.length) {
                const top = ints[0]?.frequency ?? 1
                const bar = (f) => {
                    const filled = Math.max(1, Math.round(((f ?? 1) / top) * 5))
                    return '▰'.repeat(filled) + '▱'.repeat(5 - filled)
                }
                embed.addFields({
                    name: '🎯 Top Interests',
                    value: ints
                        .slice(0, 6)
                        .map((r) => `\`${bar(r.frequency)}\` ${r.topic}`)
                        .join('\n'),
                    inline: false,
                })
            }
            if (pers?.traits)
                embed.addFields({
                    name: '🎭 Detected Personality',
                    value: String(pers.traits).slice(0, 1024),
                    inline: false,
                })
            if (summary)
                embed.addFields({
                    name: '📝 Long-term Notes',
                    value: String(summary).slice(0, 1024),
                    inline: false,
                })
            embed.setFooter({
                text: '/forgetme wipes all of this • Medusa',
                iconURL: interaction.user.displayAvatarURL(),
            })
            return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral })
        }

        // /forgetme
        if (commandName === 'forgetme') {
            const userId = interaction.user.id
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('fm_confirm')
                    .setLabel('Confirm wipe')
                    .setStyle(ButtonStyle.Danger)
                    .setEmoji('✅'),
                new ButtonBuilder()
                    .setCustomId('fm_cancel')
                    .setLabel('Cancel')
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('❌'),
            )
            const embed = new EmbedBuilder()
                .setTitle('⚠️ Are you sure?')
                .setDescription(
                    'This will **permanently delete** everything Medusa remembers about you:\n• Conversation history\n• Interests & topics\n• Personality profile\n• Aliases\n• Your custom persona (`/prompt` setting)',
                )
                .setColor(0xef9f27)
            const response = await interaction.reply({
                embeds: [embed],
                components: [row],
                flags: MessageFlags.Ephemeral,
                withResponse: true,
            })
            const msg = response.resource?.message || (await interaction.fetchReply())
            const col = msg.createMessageComponentCollector({
                componentType: ComponentType.Button,
                time: 30_000,
            })
            col.on('collect', async (i) => {
                if (i.user.id !== userId)
                    return i.reply({ content: 'Not your button.', flags: MessageFlags.Ephemeral })
                col.stop()
                if (i.customId === 'fm_cancel')
                    return i.update({
                        content: 'Cancelled, your memory is safe 💜',
                        embeds: [],
                        components: [],
                    })
                const managers = [ai.globalMem, ...ai.isolatedMems.values()]
                for (const m of managers)
                    try {
                        m.wipeUser(userId)
                    } catch {}
                ai._invalidateUserCache(userId)
                for (const k of [...ai.messageHistory.keys()])
                    if (k.startsWith(`${userId}-`)) ai.messageHistory.delete(k)
                try {
                    ai.ghost?.clearUser?.(userId)
                } catch {}
                if (ai.customPrompts[userId]) {
                    delete ai.customPrompts[userId]
                    ai._scheduleUsersSave()
                }
                await i.update({
                    content: '✅ Done, Medusa has forgotten everything about you. Fresh start 🌸',
                    embeds: [],
                    components: [],
                })
                // Optional second wipe: saved timezone, which has nothing to
                // do with chat history. Only offered when one exists.
                if (getSavedTimezone(userId)) {
                    const tzRow = new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId('fm_tz_yes')
                            .setLabel('Forget it too')
                            .setStyle(ButtonStyle.Danger)
                            .setEmoji('✅'),
                        new ButtonBuilder()
                            .setCustomId('fm_tz_no')
                            .setLabel('Keep it')
                            .setStyle(ButtonStyle.Secondary)
                            .setEmoji('❌'),
                    )
                    const follow = await i.followUp({
                        content:
                            'One more thing — you have a saved timezone. That lives apart from chat history; forgetting it only stops time answers knowing your zone. Forget it too?',
                        components: [tzRow],
                        flags: MessageFlags.Ephemeral,
                    })
                    const tzCol = follow.createMessageComponentCollector({
                        componentType: ComponentType.Button,
                        time: 30_000,
                    })
                    tzCol.on('collect', async (ti) => {
                        if (ti.user.id !== userId)
                            return ti.reply({ content: 'Not your button.', flags: MessageFlags.Ephemeral })
                        tzCol.stop()
                        if (ti.customId === 'fm_tz_yes' && deleteUserTimezone(userId)) {
                            return ti.update({
                                content: '✅ Timezone forgotten too.',
                                embeds: [],
                                components: [],
                            })
                        }
                        return ti.update({
                            content: 'Kept your timezone 💜',
                            embeds: [],
                            components: [],
                        })
                    })
                    tzCol.on('end', () => follow.edit({ components: [] }).catch(() => {}))
                }
            })
            col.on('end', () => interaction.editReply({ components: [] }).catch(() => {}))
            return
        }

        // /mode
        if (commandName === 'mode') {
            const input = interaction.options.getString('mode')
            const uid2 = interaction.user.id
            if (!input) {
                const cur = ai.userModes[uid2] ?? 0
                return interaction.reply({
                    content: `Your current mode: **${['normal', 'focused', 'fast'][cur] ?? 'normal'}** (${cur}).\nUse \`/mode focused\`, \`/mode normal\`, or \`/mode fast\` to switch.`,
                    flags: MessageFlags.Ephemeral,
                })
            }
            if (['focused', '1'].includes(input)) {
                ai.userModes[uid2] = 1
                ai._scheduleUsersSave()
                return interaction.reply({
                    content: `✅ Switched to **focused mode** - task-oriented responses (${ai._modeChat(uid2).model})`,
                    flags: MessageFlags.Ephemeral,
                })
            }
            if (['fast', '2'].includes(input)) {
                ai.userModes[uid2] = 2
                ai._scheduleUsersSave()
                return interaction.reply({
                    content: `✅ Switched to **fast mode** - ultrashort replies (${ai._modeChat(uid2).model})`,
                    flags: MessageFlags.Ephemeral,
                })
            }
            if (['normal', '0'].includes(input)) {
                delete ai.userModes[uid2]
                ai._scheduleUsersSave()
                return interaction.reply({
                    content: '✅ Switched to **normal mode** - Full personality and casual responses',
                    flags: MessageFlags.Ephemeral,
                })
            }
            return interaction.reply({
                content: '❌ Invalid mode. Use `focused`/`1`, `normal`/`0`, or `fast`/`2`',
                flags: MessageFlags.Ephemeral,
            })
        }

        // /streaming
        if (commandName === 'streaming') {
            const input = interaction.options.getString('mode')
            const uid2 = interaction.user.id
            if (!input) {
                const cur = ai.userStreams[uid2] !== false
                return interaction.reply({
                    content: `Your streaming is currently **${cur ? 'on' : 'off'}** (on = typing + fancy streaming text, off = whole replies with no typing).\nUse \`/streaming on\` or \`/streaming off\` to switch.`,
                    flags: MessageFlags.Ephemeral,
                })
            }
            // Sparse default: absent means on (host gate decides), so
            // reverting just deletes the key instead of writing `true`.
            if (input === 'on') delete ai.userStreams[uid2]
            else ai.userStreams[uid2] = false
            ai._scheduleUsersSave()
            return interaction.reply({
                content:
                    input === 'on'
                        ? '✅ Streaming **on** — normal typing indicator + streaming text.'
                        : '✅ Streaming **off** — whole replies, no typing indicator (same provider speed, just silent until it lands).',
                flags: MessageFlags.Ephemeral,
            })
        }

        // /billing — per-user usage footer. Sparse like everything else:
        // on writes `true`, off deletes the key (absent = off).
        if (commandName === 'billing') {
            const input = interaction.options.getString('mode')
            const uid2 = interaction.user.id
            if (input === 'on') {
                ai.userBilling[uid2] = true
                ai._scheduleUsersSave()
                return interaction.reply({
                    content: '✅ Billing footer **on** — replies show usage (`in/out · total · time · t/s`).',
                    flags: MessageFlags.Ephemeral,
                })
            }
            delete ai.userBilling[uid2]
            ai._scheduleUsersSave()
            return interaction.reply({
                content: '✅ Billing footer **off** — clean replies.',
                flags: MessageFlags.Ephemeral,
            })
        }

        // /prompt — view, set, or reset your custom persona.
        if (commandName === 'prompt') {
            const uid2 = String(interaction.user.id)
            if (interaction.options.getString('reset') === 'on') {
                if (ai.customPrompts[uid2]) {
                    delete ai.customPrompts[uid2]
                    ai._scheduleUsersSave()
                    ai._invalidateUserCache?.(uid2)
                    return interaction.reply({
                        content: '✅ Prompt reset to default.',
                        flags: MessageFlags.Ephemeral,
                    })
                }
                return interaction.reply({
                    content: "You don't have a custom prompt set.",
                    flags: MessageFlags.Ephemeral,
                })
            }
            const system = (interaction.options.getString('system') ?? '').trim()
            if (!system) {
                const cur = ai.customPrompts[uid2]
                return interaction.reply({
                    content: cur
                        ? `Your custom persona: ${cur.slice(0, 900)}`
                        : 'No custom persona set. Pass `system` to set one, or `reset:true` to wipe it.',
                    flags: MessageFlags.Ephemeral,
                })
            }
            if (containsDisallowedHate(system, { persona: true })) {
                return interaction.reply({ content: safetyRefusal(system), flags: MessageFlags.Ephemeral })
            }
            ai.customPrompts[uid2] = system.slice(0, 2000)
            ai._scheduleUsersSave()
            ai._invalidateUserCache?.(uid2)
            return interaction.reply({
                content: '✅ Custom persona set.',
                flags: MessageFlags.Ephemeral,
            })
        }

        // /server-prompt — guild persona, Manage Server only.
        if (commandName === 'server-prompt') {
            if (!interaction.guild)
                return interaction.reply({ content: 'Server only.', flags: MessageFlags.Ephemeral })
            const canManage =
                String(interaction.user.id) === String(OWNER_ID) ||
                !!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
            if (!canManage)
                return interaction.reply({
                    content: 'You need **Manage Server**.',
                    flags: MessageFlags.Ephemeral,
                })
            const gid = interaction.guild.id
            if (interaction.options.getString('reset') === 'on') {
                if (ai.serverPrompts[gid]) {
                    delete ai.serverPrompts[gid]
                    ai._scheduleUsersSave()
                    for (const k of ai.userCache?.keys?.() ?? [])
                        if (k.endsWith(`_${gid}`)) ai.userCache.delete(k)
                    return interaction.reply({
                        content: '✅ Server persona reset to default.',
                        flags: MessageFlags.Ephemeral,
                    })
                }
                return interaction.reply({
                    content: 'This server has no custom persona.',
                    flags: MessageFlags.Ephemeral,
                })
            }
            const system = (interaction.options.getString('system') ?? '').trim()
            if (!system) {
                const cur = ai.serverPrompts[gid]
                return interaction.reply({
                    content: cur
                        ? `Current server persona: ${cur.slice(0, 900)}`
                        : 'No server persona set. Pass `system` to set one.',
                    flags: MessageFlags.Ephemeral,
                })
            }
            if (containsDisallowedHate(system, { persona: true })) {
                return interaction.reply({ content: safetyRefusal(system), flags: MessageFlags.Ephemeral })
            }
            ai.serverPrompts[gid] = system.slice(0, 2000)
            ai._scheduleUsersSave()
            for (const k of ai.userCache?.keys?.() ?? []) if (k.endsWith(`_${gid}`)) ai.userCache.delete(k)
            return interaction.reply({
                content: `✅ Server persona set for **${interaction.guild.name}**.`,
                flags: MessageFlags.Ephemeral,
            })
        }

        // /recall — fully private memory lookup (ephemeral, only the invoker sees).
        if (commandName === 'recall') {
            if (!interaction.guild)
                return interaction.reply({ content: 'Server only.', flags: MessageFlags.Ephemeral })
            const isMod =
                String(interaction.user.id) === String(OWNER_ID) ||
                !!interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)
            const text = await buildRecallText(
                ai,
                interaction.guild,
                String(interaction.user.id),
                isMod,
                interaction.options.getString('target') ?? '',
                { ephemeralHint: true },
            )
            return interaction.reply({ content: text || '…', flags: MessageFlags.Ephemeral })
        }

        if (commandName === 'ai-pause') {
            const guild = interaction.guild
            if (!guild) return interaction.reply({ content: 'Server only.', flags: MessageFlags.Ephemeral })
            if (!isOwner && !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator))
                return interaction.reply({ content: 'Administrator only.', flags: MessageFlags.Ephemeral })
            const action = interaction.options.getString('action')
            const pausedNow = ai.pausedGuilds.has(guild.id)
            if (action === 'pause') {
                if (pausedNow)
                    return interaction.reply({
                        content: `AI is already paused in **${guild.name}**.`,
                        flags: MessageFlags.Ephemeral,
                    })
                ai.pausedGuilds.add(guild.id)
                setConfigGuild(guild.id, { ai: false })
                return interaction.reply({
                    content: `\u23f8\ufe0f AI paused in **${guild.name}**. Any admin can bring her back with \`/ai-pause resume\`.`,
                })
            }
            if (!pausedNow)
                return interaction.reply({
                    content: `AI isn't paused in **${guild.name}**.`,
                    flags: MessageFlags.Ephemeral,
                })
            ai.pausedGuilds.delete(guild.id)
            setConfigGuild(guild.id, { ai: undefined })
            return interaction.reply({
                content: `\u25b6\ufe0f AI resumed in **${guild.name}**, she's listening again.`,
            })
        }

        // owner-only commands
        if (!isOwner) return
        if (commandName === 'debug') {
            ai.debugMode = !ai.debugMode
            globalThis._medusaDebug = ai.debugMode
            if (ai.debugMode) {
                // Fresh scratch state per session: prod DBs stay untouched.
                try {
                    const { rmSync } = await import('fs')
                    rmSync('data/ai/debug - debug', { recursive: true, force: true })
                } catch {}
                ai._debugMem = null
            }
            try {
                const raw = readConfigRaw()
                raw.debug = ai.debugMode
                writeConfigRaw(raw)
            } catch {}
            console.warn(
                `[AI] Debug mode ${ai.debugMode ? 'ON — owner-only, scratch DB, no passive buffering' : 'OFF — normal operation'}`,
            )
            return interaction.reply({
                content: ai.debugMode
                    ? '🔧 Debug mode **ON** — I only answer you now (looks paused to everyone else), memory goes to a scratch DB, passive buffering is off, logs are verbose. Toggle again to go back.'
                    : '🔧 Debug mode **OFF** — normal operation resumed.',
                flags: MessageFlags.Ephemeral,
            })
        }
        if (commandName === 'isolation') {
            const guild = interaction.guild
            if (!guild) return interaction.reply({ content: 'Server only.', flags: MessageFlags.Ephemeral })
            const wantIsolated = interaction.options.getString('active') === 'on'
            const isIsolated = ai.isolatedServers.has(guild.id)
            if (wantIsolated === isIsolated)
                return interaction.reply({
                    content: isIsolated
                        ? `**${guild.name}** is already isolated.`
                        : `**${guild.name}** isn't isolated.`,
                    flags: MessageFlags.Ephemeral,
                })
            if (wantIsolated) {
                const mem = new AIMemoryManager(guild.id, guild.name)
                ai.isolatedServers.add(guild.id)
                ai.isolatedMems.set(guild.id, mem)
                saveRuntime({ isolatedGuilds: [...ai.isolatedServers] })
                return interaction.reply({
                    content: mem.resumed
                        ? `🔒 **${guild.name}** isolated, picked its old memory folder back up.`
                        : `🔒 **${guild.name}** isolated, it now has its own AI memory.`,
                    flags: MessageFlags.Ephemeral,
                })
            }
            ai.isolatedServers.delete(guild.id)
            ai.isolatedMems.delete(guild.id)
            saveRuntime({ isolatedGuilds: [...ai.isolatedServers] })
            return interaction.reply({
                content: `🔓 **${guild.name}** un-isolated, back on global memory. Its folder stays on disk, so isolating again resumes where it left off.`,
                flags: MessageFlags.Ephemeral,
            })
        }
        if (commandName === 'configclean') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral })
            const removed = []
            const liveChannel = async (id) => {
                if (client.channels.cache.has(id)) return true
                return !!(await client.channels.fetch(id).catch(() => null))
            }
            try {
                const raw = readConfigRaw()
                if (raw.guilds && typeof raw.guilds === 'object' && !Array.isArray(raw.guilds)) {
                    for (const id of Object.keys(raw.guilds)) {
                        if (!client.guilds.cache.has(String(id))) {
                            delete raw.guilds[id]
                            removed.push(`guild \`${id}\``)
                        }
                    }
                    if (!Object.keys(raw.guilds).length) delete raw.guilds
                }
                for (const key of [
                    'alwaysActiveChannels',
                    'funChannels',
                    'always_active_channels',
                    'fun_channels',
                ]) {
                    if (!Array.isArray(raw[key])) continue
                    const keep = []
                    for (const id of raw[key].map(String)) {
                        if (/^\d{15,20}$/.test(id) && (await liveChannel(id))) keep.push(id)
                        else removed.push(`${key} \`${id}\``)
                    }
                    raw[key] = keep
                }
                if (removed.length) writeConfigRaw(raw)
            } catch (e) {
                return interaction.editReply({ content: `Cleanup failed: ${e.message}` })
            }
            const staleIso = [...ai.isolatedServers].filter((id) => !client.guilds.cache.has(id))
            for (const id of staleIso) {
                ai.isolatedServers.delete(id)
                ai.isolatedMems.delete(id)
                removed.push(`isolation \`${id}\``)
            }
            if (staleIso.length) saveRuntime({ isolatedGuilds: [...ai.isolatedServers] })
            for (const id of [...ai.pausedGuilds])
                if (!client.guilds.cache.has(id)) ai.pausedGuilds.delete(id)
            if (!removed.length)
                return interaction.editReply({ content: 'Config is clean, nothing stale in there.' })
            return interaction.editReply({
                content:
                    `🧽 Cleaned ${removed.length} stale entr${removed.length === 1 ? 'y' : 'ies'}:\n${removed.map((r) => `• ${r}`).join('\n')}`.slice(
                        0,
                        1900,
                    ),
            })
        }
    })

    // prefix commands for AI
    client.commands.set('p', async (msg, args) => {
        const text = args.join(' ')
        if (!text) return msg.reply('Please provide a prompt.')
        const uid = String(msg.author.id)
        if (containsDisallowedHate(text, { persona: true })) {
            if (msg.guild)
                logAction(
                    db,
                    msg.guild.id,
                    uid,
                    client.user.id,
                    'AI safety block',
                    'Unsafe custom persona prompt',
                )
            return msg.reply(safetyRefusal(text))
        }
        ai.customPrompts[uid] = text
        ai._scheduleUsersSave()
        const modeNote =
            ai.userModes[uid] === 1
                ? ` (focused mode stays on and styles it)`
                : ai.userModes[uid] === 2
                  ? ` (fast mode stays on and keeps replies ultrashort)`
                  : ''
        await msg.reply(`✅ Custom prompt set for ${msg.author.displayName}${modeNote}`)
    })
    client.commands.set('prompt', client.commands.get('p'))
    client.commands.set('promptreset', client.commands.get('pr'))
    client.commands.set('pr', async (msg) => {
        const uid = String(msg.author.id)
        if (ai.customPrompts[uid]) {
            delete ai.customPrompts[uid]
            ai._scheduleUsersSave()
            ai._invalidateUserCache?.(uid)
            await msg.reply(`✅ Prompt reset to default for ${msg.author.displayName}`)
        } else await msg.reply("You don't have a custom prompt set.")
    })
    client.commands.set('serverp', async (msg, args) => {
        if (!msg.guild) return msg.reply('Server personas only work in a server.')
        const canManage =
            String(msg.author.id) === String(config.ownerId) ||
            msg.member?.permissions?.has(PermissionFlagsBits.ManageGuild)
        if (!canManage) return msg.reply('You need **Manage Server** to change the server persona.')
        const text = args.join(' ')
        if (!text) {
            const cur = ai.serverPrompts[msg.guild.id]
            return msg.reply(cur ? `Current server persona: ${cur.slice(0, 600)}` : 'No server persona set.')
        }
        if (containsDisallowedHate(text, { persona: true })) {
            logAction(
                db,
                msg.guild.id,
                String(msg.author.id),
                client.user.id,
                'AI safety block',
                'Unsafe server persona',
            )
            return msg.reply(safetyRefusal(text))
        }
        ai.serverPrompts[msg.guild.id] = text
        ai._scheduleUsersSave()
        await msg.reply(`✅ Server persona set for ${msg.guild.name}`)
    })
    client.commands.set('serverpr', async (msg) => {
        if (!msg.guild) return msg.reply('Server personas only work in a server.')
        const canManage =
            String(msg.author.id) === String(config.ownerId) ||
            msg.member?.permissions?.has(PermissionFlagsBits.ManageGuild)
        if (!canManage) return msg.reply('You need **Manage Server** to reset the server persona.')
        if (!ai.serverPrompts[msg.guild.id]) return msg.reply('This server has no custom persona.')
        delete ai.serverPrompts[msg.guild.id]
        ai._scheduleUsersSave()
        await msg.reply('✅ Server persona reset to default')
    })
    client.commands.set('serverprompt', client.commands.get('serverp'))
    client.commands.set('serverpromptreset', client.commands.get('serverpr'))
    client.commands.set('mode', async (msg, args) => {
        const input = args[0]?.toLowerCase()
        const uid = String(msg.author.id)
        if (!input) {
            const cur = ai.userModes[uid] ?? 0
            return msg.reply(
                `Your current mode: **${['normal', 'focused', 'fast'][cur] ?? 'normal'}** (${cur}). Use \`${config.prefix}mode focused\`, \`${config.prefix}mode normal\`, or \`${config.prefix}mode fast\`.`,
            )
        }
        let newMode = null
        if (['focused', '1'].includes(input)) newMode = 1
        else if (['fast', '2'].includes(input)) newMode = 2
        else if (['normal', '0'].includes(input)) newMode = 0
        else return msg.reply('❌ Invalid mode. Use `focused`/`1`, `normal`/`0`, or `fast`/`2`')

        if (newMode === 0) delete ai.userModes[uid]
        else ai.userModes[uid] = newMode
        ai._scheduleUsersSave()
        const modeName = ['normal', 'focused', 'fast'][newMode]
        return msg.reply(`✅ Switched to **${modeName} mode** (${ai._modeChat(uid).model})`)
    })
    client.commands.set('stream', async (msg, args) => {
        const input = args[0]?.toLowerCase()
        const uid = String(msg.author.id)
        if (!input) {
            const cur = ai.userStreams[uid] !== false
            return msg.reply(
                `Your streaming is currently **${cur ? 'on' : 'off'}** (on = typing + fancy streaming text, off = whole replies with no typing). Use \`${config.prefix}stream on\` or \`${config.prefix}stream off\`.`,
            )
        }
        if (!['on', 'off'].includes(input)) return msg.reply('❌ Use `on` or `off`.')
        if (input === 'on') delete ai.userStreams[uid]
        else ai.userStreams[uid] = false
        ai._scheduleUsersSave()
        return msg.reply(
            input === 'on'
                ? '✅ Streaming **on** — normal typing indicator + streaming text.'
                : '✅ Streaming **off** — whole replies, no typing indicator (same provider speed, just silent until it lands).',
        )
    })
    client.commands.set('billing', async (msg, args) => {
        const input = args[0]?.toLowerCase()
        const uid = String(msg.author.id)
        if (!input) {
            const cur = ai.userBilling[uid] === true
            return msg.reply(
                `Your billing footer is currently **${cur ? 'on' : 'off'}**. Use \`${config.prefix}billing on\` or \`${config.prefix}billing off\`.`,
            )
        }
        if (!['on', 'off'].includes(input)) return msg.reply('❌ Use `on` or `off`.')
        if (input === 'on') ai.userBilling[uid] = true
        else delete ai.userBilling[uid]
        ai._scheduleUsersSave()
        return msg.reply(
            input === 'on'
                ? '✅ Billing footer **on** — replies show usage (`in/out · total · time · t/s`).'
                : '✅ Billing footer **off** — clean replies.',
        )
    })
    // Memory lookup by name: what the server roster says + what she remembers.
    // Results post visibly (and land in history), so "who is X / is X here" gets
    // answered from data instead of guessed from vibes.
    client.commands.set('recall', async (msg, args) => {
        const isMod =
            String(msg.author.id) === String(OWNER_ID) ||
            !!msg.member?.permissions?.has(PermissionFlagsBits.ModerateMembers)
        const text = await buildRecallText(ai, msg.guild, String(msg.author.id), isMod, args.join(' ').trim())
        if (!text) return
        const sent = await msg.reply(text)
        // Privacy window: memory profiles shouldn't sit in chat forever.
        setTimeout(() => sent?.delete?.().catch(() => {}), 60_000).unref()
    })

    client.commands.set(
        'aihistory',
        ownerOnly(async (msg, args) => {
            const uid = args[0] ?? msg.author.id
            const hist = ai.globalMem.getHistory(String(uid), parseInt(args[1]) || 5)
            if (!hist.length) return msg.reply(`No history for user ${uid}`)
            const lines = hist.map(
                (r, i) =>
                    `${i + 1}. User: ${r.message_content.slice(0, 100)}\n   AI: ${r.ai_response.slice(0, 100)}\n   Time: ${r.timestamp}`,
            )
            for (const chunk of ai.splitResponse(`**History for ${uid}:**\n${lines.join('\n\n')}`))
                await msg.reply(chunk)
        }),
    )
    client.commands.set(
        'aiclear',
        ownerOnly(async (msg, args) => {
            const uid = args[0]
            if (!uid) return msg.reply('Please provide a user ID.')
            for (const m of [ai.globalMem, ...ai.isolatedMems.values()])
                try {
                    m.wipeUser(uid)
                } catch {}
            ai._invalidateUserCache(uid)
            for (const k of [...ai.messageHistory.keys()])
                if (k.startsWith(`${uid}-`)) ai.messageHistory.delete(k)
            try {
                ai.ghost?.clearUser?.(uid)
            } catch {}
            await msg.reply(`Cleared all data for user ${uid}`)
        }),
    )
    client.commands.set(
        'aianalyze',
        ownerOnly(async (msg, args) => {
            const uid = args[0] ?? msg.author.id
            const user = ai.globalMem.getUser(String(uid))
            if (!user) return msg.reply(`No data for user ID: ${uid}`)
            const ints = ai.globalMem.getInterests(String(uid))
            const lines = [
                `**Analysis for ${user.display_name} (${user.username})**`,
                `Conversations: ${user.conversation_count}`,
            ]
            if (ints.length)
                lines.push(
                    `Interests: ${ints
                        .slice(0, 3)
                        .map((r) => `${r.topic}(${r.frequency})`)
                        .join(', ')}`,
                )
            const query = args.slice(1).join(' ')
            if (query) {
                const hist = ai.globalMem.getHistory(String(uid), 3)
                const convTxt = hist.map((r) => `User: ${r.message_content}\nAI: ${r.ai_response}`).join('\n')
                const analysis = await ai.generateResponse({
                    prompt: `Analyze this user and answer: ${query}\nConversations:\n${convTxt}`,
                })
                if (analysis) lines.push(`**AI Analysis:**\n${analysis}`)
            }
            for (const chunk of ai.splitResponse(lines.join('\n\n'))) await msg.reply(chunk)
        }),
    )

    console.log('[AI] Manager initialized, listeners registered')
    // Build fingerprint: proves which feature set is actually running on the
    // host. Compare against the repo when behavior doesn't match the code.
    console.log(
        `[AI] Confirm UI: ${typeof ai._watchConfirmUI === 'function' ? 'buttons+modal' : 'MISSING'}, ` +
            `selects: ${typeof ai._answerConfirm === 'function' ? 'on' : 'off'}, ` +
            `second-thoughts: ${typeof ai._secondThought === 'function' ? 'on' : 'off'}`,
    )
    return ai
}

// Additional slash commands to add to index.js registration
export function buildAISlashCommands() {
    return [
        new SlashCommandBuilder()
            .setName('memory')
            .setDescription('Peek at what Medusa remembers — or turn memory On/Off for you')
            .setContexts(0)
            .addStringOption((o) =>
                o
                    .setName('mode')
                    .setDescription('On = she remembers chats, Off = nothing stored or fetched')
                    .addChoices({ name: 'On', value: 'on' }, { name: 'Off', value: 'off' }),
            ),
        new SlashCommandBuilder()
            .setName('forgetme')
            .setContexts(0)
            .setDescription('Delete everything Medusa remembers about you'),
        new SlashCommandBuilder()
            .setName('prompt')
            .setContexts(0)
            .setDescription('Set, view, or reset your custom persona')
            .addStringOption((o) =>
                o.setName('system').setDescription('Your custom persona/instructions (omit to view current)'),
            )
            .addStringOption((o) =>
                o
                    .setName('reset')
                    .setDescription('On wipes your custom persona back to default')
                    .addChoices({ name: 'On', value: 'on' }, { name: 'Off', value: 'off' }),
            ),
        new SlashCommandBuilder()
            .setName('server-prompt')
            .setContexts(0)
            .setDescription('Set, view, or reset this server persona (Manage Server)')
            .addStringOption((o) =>
                o.setName('system').setDescription('Server persona/instructions (omit to view current)'),
            )
            .addStringOption((o) =>
                o
                    .setName('reset')
                    .setDescription('On wipes the server persona back to default')
                    .addChoices({ name: 'On', value: 'on' }, { name: 'Off', value: 'off' }),
            ),
        new SlashCommandBuilder()
            .setName('mode')
            .setContexts(0)
            .setDescription('Switch between focused/normal/fast AI mode')
            .addStringOption((o) =>
                o
                    .setName('mode')
                    .setDescription('focused, normal, or fast')
                    .addChoices(
                        { name: 'focused', value: 'focused' },
                        { name: 'normal', value: 'normal' },
                        { name: 'fast', value: 'fast' },
                    ),
            ),
        new SlashCommandBuilder()
            .setName('streaming')
            .setContexts(0)
            .setDescription('Pick instant replies or fancy streaming text (just for you)')
            .addStringOption((o) =>
                o
                    .setName('mode')
                    .setDescription('on = typing + streaming, off = instant, no typing indicator')
                    .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }),
            ),
        new SlashCommandBuilder()
            .setName('billing')
            .setContexts(0)
            .setDescription('Show token usage footer on replies (just for you)')
            .addStringOption((o) =>
                o
                    .setName('mode')
                    .setDescription('on = usage footer, off = clean replies')
                    .setRequired(true)
                    .addChoices({ name: 'On', value: 'on' }, { name: 'Off', value: 'off' }),
            ),
        new SlashCommandBuilder()
            .setName('recall')
            .setDescription('Look up what Medusa remembers about a member (only you see this)')
            .setContexts(0)
            .addStringOption((o) =>
                o.setName('target').setDescription('Name, @mention, or user ID').setRequired(true),
            ),
        new SlashCommandBuilder()
            .setName('ai-pause')
            .setDescription('Pause or resume the AI in this server (admins)')
            .setContexts(0)
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .addStringOption((o) =>
                o
                    .setName('action')
                    .setDescription('pause or resume')
                    .setRequired(true)
                    .addChoices({ name: 'pause', value: 'pause' }, { name: 'resume', value: 'resume' }),
            ),
        // Owner-only. Locked to admins at the API level so regular members never
        // see them, and the handlers hard-gate on the owner id anyway.
        new SlashCommandBuilder()
            .setName('isolation')
            .setDescription('Give this server its own AI memory (owner)')
            .setContexts(0)
            .setDefaultMemberPermissions('0')
            .addStringOption((o) =>
                o
                    .setName('active')
                    .setDescription('On isolates, Off goes back to global memory')
                    .setRequired(true)
                    .addChoices({ name: 'On', value: 'on' }, { name: 'Off', value: 'off' }),
            ),
        new SlashCommandBuilder()
            .setName('configclean')
            .setDescription('Sweep dead server/channel ids out of config.json (owner)')
            .setContexts(0)
            .setDefaultMemberPermissions('0'),
        new SlashCommandBuilder()
            .setName('debug')
            .setDescription('Toggle debug mode: owner-only replies, scratch DB, verbose logs (owner)')
            .setContexts(0)
            .setDefaultMemberPermissions('0'),
        new SlashCommandBuilder()
            .setName('summarize')
            .setDescription('Summarize recent conversation')
            .setIntegrationTypes(0, 1)
            .setContexts(0, 1, 2)
            .addStringOption((o) =>
                o.setName('start-from').setDescription('Message ID or link to start from'),
            ),
        new SlashCommandBuilder()
            .setName('medusa')
            .setDescription(
                'Ask Medusa one quick question, nothing gets remembered. DMs and group chats only.',
            )
            .setIntegrationTypes(0, 1)
            .setContexts(1, 2)
            .addStringOption((o) =>
                o
                    .setName('prompt')
                    .setDescription('What do you want to ask?')
                    .setRequired(true)
                    .setMaxLength(1800),
            )
            .addStringOption((o) =>
                o
                    .setName('search')
                    .setDescription('Web research: Auto, On, or Off (default Auto)')
                    .addChoices(
                        { name: 'Auto', value: 'auto' },
                        { name: 'On', value: 'on' },
                        { name: 'Off', value: 'off' },
                    ),
            )
            .addStringOption((o) =>
                o
                    .setName('privacy')
                    .setDescription('On = only you see it (default Off)')
                    .addChoices({ name: 'On', value: 'on' }, { name: 'Off', value: 'off' }),
            ),
        new SlashCommandBuilder()
            .setName('ask')
            .setContexts(0)
            .setDescription('Quick precise answer with light memory (server only, instant)')
            .addStringOption((o) =>
                o
                    .setName('prompt')
                    .setDescription('What do you want to ask?')
                    .setRequired(true)
                    .setMaxLength(1800),
            )
            .addStringOption((o) =>
                o
                    .setName('research')
                    .setDescription('Web research: Auto, On, or Off (default Auto)')
                    .addChoices(
                        { name: 'Auto', value: 'auto' },
                        { name: 'On', value: 'on' },
                        { name: 'Off', value: 'off' },
                    ),
            )
            .addStringOption((o) =>
                o
                    .setName('privacy')
                    .setDescription('On = only you see it (default Off)')
                    .addChoices({ name: 'On', value: 'on' }, { name: 'Off', value: 'off' }),
            ),
    ].map((c) => c.toJSON())
}
