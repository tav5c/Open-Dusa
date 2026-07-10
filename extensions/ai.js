// Medusa AI — extension entry point. The engine lives in extensions/ai/ as a
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
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { loadPerformance } from './performance.js'
import { saveRuntime } from './config.js'
import { AIChatManager } from './ai/chat.js'
import { AIMemoryManager } from './ai/memory.js'
import { containsDisallowedHate, safetyRefusal } from './ai/safety.js'
import { logAction } from './moderation.js'

export { _undiciAgent } from './ai/providers.js'

const PERF = loadPerformance()

// Register function (called from index.js)
let OWNER_ID = null
const ownerOnly = (fn) => async (msg, args) => {
    if (String(msg.author.id) !== String(OWNER_ID)) return
    await fn(msg, args)
}
export async function registerAI(client, db, config) {
    OWNER_ID = config.ownerId
    try {
        if (!globalThis._sqlite3) {
            const mod = await import('better-sqlite3')
            globalThis._sqlite3 = { default: mod.default ?? mod }
        }
    } catch (e) {
        console.error('[AI] better-sqlite3 not available — install on host:', e.message)
    }
    try {
        const dataDir = 'Ai Database'
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
                // Sort by DB size descending — keep the largest as the primary
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
                        console.log(`[AI] Merged "${other.name}" → "${primary.name}"`)
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

    client.on('messageCreate', async (msg) => {
        try {
            await ai.onMessage(msg)
        } catch (e) {
            console.error('[AI] Fatal onMessage error:', e)
        }
    })

    client.on('guildMemberAdd', (member) => {
        if (!member.guild) return
        const mem = ai.getMem(member.guild)
        mem.updateUser(member.id, member.user.username, member.displayName)
    })

    client.on('messageDelete', (msg) => {
        ai.processedMsgIds?.delete?.(msg.id)
        ai.triggeredMsgs?.delete?.(msg.id)
    })

    client.on('messageCreate', (msg) => {
        if (msg.author.bot) return
        if (!msg.guild) return
        if (!msg.content?.trim()) return
        if (msg.content.length < 3) return
        if (containsDisallowedHate(msg.content)) return
        const everyonePerms = msg.channel.permissionsFor(msg.guild.roles.everyone)
        if (!everyonePerms?.has('ViewChannel')) return

        if (ai.allowedGuilds.size && !ai.allowedGuilds.has(msg.guild.id)) return

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
        if (!interaction.isChatInputCommand()) return
        const { commandName } = interaction
        const uid = interaction.user.id
        const isOwner = uid === OWNER_ID

        // /medusa (Quick Agent) — stateless, user-installable, DM-allowed
        if (commandName === 'medusa') {
            const prompt = interaction.options.getString('prompt')
            const forceSearch = interaction.options.getBoolean('search') ?? false
            const isPrivate = interaction.options.getBoolean('private') ?? false
            const flags = isPrivate ? MessageFlags.Ephemeral : undefined

            await interaction.deferReply(flags ? { flags } : {})

            const isStaff = !!interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)
            const gate = client.heart?.rateLimiter?.check(uid, { isStaff, isOwner })
            if (gate && !gate.ok) {
                return interaction.editReply({
                    content: '⏳ Too many requests. Wait a few seconds and try again.',
                })
            }

            try {
                const response = await ai.generateStatelessResponse({ prompt, forceSearch })
                if (!response)
                    return interaction.editReply({ content: '✗ All providers failed. Try again shortly.' })

                const safe = ai.finalSecurityCheck(response, interaction)
                const chunks = ai.splitResponse(safe, 1900)
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

        // /summarize

        if (commandName === 'summarize') {
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
                            content: `⏳ Cooldown — wait **${m}m ${s}s** before summarizing again.`,
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
            const startFrom = interaction.options.getString('start_from')
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
                    if (!m.author.bot && m.content.trim()) {
                        messages.push({
                            author: m.member?.displayName ?? m.author.username,
                            content: m.content,
                            ts: m.createdAt,
                        })
                        if (messages.length >= 100) break
                    }
                }
                if (!startMsg.author.bot && startMsg.content.trim())
                    messages.unshift({
                        author: startMsg.member?.displayName ?? startMsg.author.username,
                        content: startMsg.content,
                        ts: startMsg.createdAt,
                    })
            } else {
                const fetched = await interaction.channel.messages.fetch({ limit: 200 })
                for (const [, m] of fetched) {
                    if (!m.author.bot && m.content.trim()) {
                        messages.push({
                            author: m.member?.displayName ?? m.author.username,
                            content: m.content,
                            ts: m.createdAt,
                        })
                        if (messages.length >= 100) break
                    }
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
            const header = `> 📋 **Conversation Summary**${startMsg ? ` (from message \`${startMsg.id}\`)` : ` (last ${messages.length} messages)`}\n> \`🕒| ${first.toISOString().slice(0, 16)}\` **__→__** \`${last.toISOString().slice(0, 16)} UTC\`\n> 👥| **${participants.length} users**\n${'─'.repeat(40)}`
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
            const mem = ai.getMem(interaction.guild)
            const user = mem.getUser(userId)
            const ints = mem.getInterests(userId, 8)
            const pers = mem.getPersonality(userId)
            const embed = new EmbedBuilder()
                .setTitle(`🧠 Medusa's Memory — ${interaction.user.displayName}`)
                .setColor(0x7f77dd)
            if (user) {
                const level =
                    user.conversation_count > 50
                        ? '🔥 active'
                        : user.conversation_count > 10
                          ? '👋 regular'
                          : '🌱 new'
                embed.addFields({
                    name: '📊 Profile',
                    value: `Conversations: \`${user.conversation_count}\` (${level})\nLast seen: \`${String(user.last_interaction ?? 'never').slice(0, 10)}\``,
                    inline: false,
                })
            } else {
                embed.addFields({
                    name: '📊 Profile',
                    value: 'No profile stored yet — say hi!',
                    inline: false,
                })
            }
            if (ints.length)
                embed.addFields({
                    name: '🎯 Top Interests',
                    value:
                        ints
                            .slice(0, 6)
                            .map((r) => `\`${r.topic}\``)
                            .join(', ') || 'None yet',
                    inline: false,
                })
            if (pers?.traits)
                embed.addFields({ name: '🎭 Detected Personality', value: pers.traits, inline: false })
            embed.setFooter({
                text: 'Use /forgetme to wipe this data. • Medusa',
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
                    'This will **permanently delete** everything Medusa remembers about you:\n• Conversation history\n• Interests & topics\n• Personality profile\n• Aliases',
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
                        content: 'Cancelled — your memory is safe 💜',
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
                if (ai.customPrompts[userId]) {
                    delete ai.customPrompts[userId]
                    if (ai._promptSaveTimer) clearTimeout(ai._promptSaveTimer)
                    ai._promptSaveTimer = setTimeout(() => {
                        ai._saveJSON('Ai Database/custom_prompts.json', ai.customPrompts)
                        ai._promptSaveTimer = null
                    }, 500)
                }
                await i.update({
                    content: '✅ Done — Medusa has forgotten everything about you. Fresh start 🌸',
                    embeds: [],
                    components: [],
                })
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
                    content: `Your current mode is: **${cur === 1 ? 'focused' : 'normal'}** (${cur}).\nUse \`/mode focused\` or \`/mode normal\` to switch.`,
                    flags: MessageFlags.Ephemeral,
                })
            }
            if (['focused', '1'].includes(input)) {
                ai.userModes[uid2] = 1
                ai._saveJSON('Ai Database/user_modes.json', ai.userModes)
                return interaction.reply({
                    content: '✅ Switched to **focused mode** - task-oriented responses',
                    flags: MessageFlags.Ephemeral,
                })
            }
            if (['normal', '0'].includes(input)) {
                ai.userModes[uid2] = 0
                ai._saveJSON('Ai Database/user_modes.json', ai.userModes)
                return interaction.reply({
                    content: '✅ Switched to **normal mode** - Full personality and casual responses',
                    flags: MessageFlags.Ephemeral,
                })
            }
            return interaction.reply({
                content: '❌ Invalid mode. Use `focused`/`1` or `normal`/`0`',
                flags: MessageFlags.Ephemeral,
            })
        }

        // lore
        if (commandName === 'lore') {
            if (!interaction.guild)
                return interaction.reply({ content: 'Server only.', flags: MessageFlags.Ephemeral })
            const mem = ai.getMem(interaction.guild)
            const sub = interaction.options.getSubcommand()
            const isMod =
                interaction.member?.permissions?.has('ManageGuild') || interaction.user.id === OWNER_ID
            if (sub === 'list') {
                const lore = mem.getLore(20)
                if (!lore.length)
                    return interaction.reply({
                        content: '📖 No server lore recorded yet.',
                        flags: MessageFlags.Ephemeral,
                    })
                const lines = lore.map((l) => `\`${l.id}\` [${l.source}×${l.frequency}] ${l.fact}`)
                return interaction.reply({
                    content: `📖 **Server Lore:**\n${lines.join('\n')}`,
                    flags: MessageFlags.Ephemeral,
                })
            }
            if (!isMod)
                return interaction.reply({
                    content: '❌ Manage Guild permission required.',
                    flags: MessageFlags.Ephemeral,
                })
            if (sub === 'add') {
                const fact = interaction.options.getString('fact')
                const ok = mem.addLore(fact, 'manual')
                return interaction.reply({
                    content: ok ? `✅ Lore added: "${fact}"` : '❌ Invalid or too long (max 120 chars).',
                    flags: MessageFlags.Ephemeral,
                })
            }
            if (sub === 'remove') {
                const id = interaction.options.getInteger('id')
                mem.removeLore(id)
                return interaction.reply({
                    content: `✅ Lore entry #${id} removed.`,
                    flags: MessageFlags.Ephemeral,
                })
            }
            if (sub === 'clear') {
                mem.db.prepare(`DELETE FROM server_lore WHERE source='auto'`).run()
                return interaction.reply({
                    content: '✅ All auto-extracted lore cleared.',
                    flags: MessageFlags.Ephemeral,
                })
            }
        }

        // ghost
        if (commandName === 'ghost') {
            const sub = interaction.options.getSubcommand()
            const scope = `${interaction.guild?.id ?? 'dm'}:${interaction.user.id}`
            if (sub === 'add') {
                const target = interaction.options.getUser('user')
                ai.ghost.add(scope, target.id)
                return interaction.reply({
                    content: `👻 Ghosted **${target.username}** — their messages won't influence your AI context.`,
                    flags: MessageFlags.Ephemeral,
                })
            }
            if (sub === 'remove') {
                const target = interaction.options.getUser('user')
                ai.ghost.remove(scope, target.id)
                return interaction.reply({
                    content: `✅ Removed **${target.username}** from ghost list.`,
                    flags: MessageFlags.Ephemeral,
                })
            }
            if (sub === 'list') {
                const list = ai.ghost.list(scope)
                if (!list.length)
                    return interaction.reply({ content: 'No ghosted users.', flags: MessageFlags.Ephemeral })
                const lines = list.map((id) => {
                    const u = client.users.cache.get(id)
                    return u ? `${u.username} (\`${id}\`)` : `\`${id}\``
                })
                return interaction.reply({
                    content: `👻 **Ghost list:**\n${lines.join('\n')}`,
                    flags: MessageFlags.Ephemeral,
                })
            }
            if (sub === 'clear') {
                ai.ghost.clear(scope)
                return interaction.reply({ content: '✅ Ghost list cleared.', flags: MessageFlags.Ephemeral })
            }
        }

        // owner-only commands
        if (!isOwner) return

        if (commandName === 'aipause') {
            ai.paused = !ai.paused
            return interaction.reply({
                content: `AI ${ai.paused ? 'paused' : 'unpaused'}`,
                flags: MessageFlags.Ephemeral,
            })
        }
        if (commandName === 'aireinit') {
            ai._initGroq()
            return interaction.reply({
                content: `Reinitialized. Success: ${!!ai._groq}`,
                flags: MessageFlags.Ephemeral,
            })
        }
        if (commandName === 'aimodel') {
            const model = interaction.options.getString('model')
            if (!model) {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral })
                try {
                    const key = ai.aiTokens[ai.currentKeyIdx]
                    const res = await fetch('https://api.groq.com/openai/v1/models', {
                        headers: { Authorization: `Bearer ${key}` },
                    })
                    const data = await res.json()
                    const models = (data.data || [])
                        .filter((m) => m.active)
                        .map((m) => `\`${m.id}\``)
                        .join(', ')
                    return interaction.editReply({
                        content: `Current: \`${ai.aiModel}\`\n\n**Available Models:**\n${models || 'Could not fetch list.'}`,
                    })
                } catch (e) {
                    return interaction.editReply({
                        content: `Current: \`${ai.aiModel}\`\nFailed to fetch models from API.`,
                    })
                }
            }
            ai.aiModel = model
            // Runtime state lives in memory never mutate source config
            try {
                const runtimePath = 'runtime.json'
                let runtime = {}
                if (existsSync(runtimePath)) {
                    runtime = JSON.parse(readFileSync(runtimePath, 'utf8'))
                }
                runtime.aiModel = model
                writeFileSync(runtimePath, JSON.stringify(runtime, null, 2))
            } catch (e) {
                console.error('[AI] Failed to persist runtime state:', e)
            }
            return interaction.reply({ content: `Model set to: \`${model}\``, flags: MessageFlags.Ephemeral })
        }
        if (commandName === 'iso') {
            const guild = interaction.guild
            if (!guild)
                return interaction.reply({
                    content: 'Must be used in a server.',
                    flags: MessageFlags.Ephemeral,
                })
            if (ai.isolatedServers.has(guild.id))
                return interaction.reply({
                    content: `**${guild.name}** is already isolated.`,
                    flags: MessageFlags.Ephemeral,
                })
            ai.isolatedServers.add(guild.id)
            ai.isolatedMems.set(guild.id, new AIMemoryManager(guild.id, guild.name))
            saveRuntime({ isolatedGuilds: [...ai.isolatedServers] })
            return interaction.reply({
                content: `✅ **${guild.name}** isolated — now has its own AI memory.`,
                flags: MessageFlags.Ephemeral,
            })
        }
        if (commandName === 'uniso') {
            const guild = interaction.guild
            if (!guild)
                return interaction.reply({
                    content: 'Must be used in a server.',
                    flags: MessageFlags.Ephemeral,
                })
            if (!ai.isolatedServers.has(guild.id))
                return interaction.reply({
                    content: `**${guild.name}** is not isolated.`,
                    flags: MessageFlags.Ephemeral,
                })
            ai.isolatedServers.delete(guild.id)
            ai.isolatedMems.delete(guild.id)
            saveRuntime({ isolatedGuilds: [...ai.isolatedServers] })
            return interaction.reply({
                content: `✅ **${guild.name}** un-isolated — using global memory now.`,
                flags: MessageFlags.Ephemeral,
            })
        }
        if (commandName === 'aiwipe') {
            ai.messageHistory.clear()
            for (const m of [ai.globalMem, ...ai.isolatedMems.values()]) {
                try {
                    m.db.exec(
                        'DELETE FROM conversations; DELETE FROM interests; DELETE FROM personality; DELETE FROM users; DELETE FROM relationships; DELETE FROM user_aliases;',
                    )
                } catch {}
            }
            return interaction.reply({ content: 'AI memory wiped', flags: MessageFlags.Ephemeral })
        }
        if (commandName === 'pm') {
            const mode = interaction.options.getString('mode')
            if (!mode)
                return interaction.reply({
                    content: `Ping mode: **${ai.pingMode ? 'enabled' : 'disabled'}**`,
                    flags: MessageFlags.Ephemeral,
                })
            ai.pingMode = ['on', 'enable', 'true', '1'].includes(mode.toLowerCase())
            saveRuntime({ pingMode: ai.pingMode })
            return interaction.reply({
                content: `Ping mode **${ai.pingMode ? 'enabled' : 'disabled'}**`,
                flags: MessageFlags.Ephemeral,
            })
        }
    })

    // prefix commands for AI
    client.commands.set('p', async (msg, args) => {
        const text = args.join(' ')
        if (!text) return msg.reply('Please provide a prompt.')
        const uid = String(msg.author.id)
        if (containsDisallowedHate(text, { persona: true })) {
            if (msg.guild) logAction(db, msg.guild.id, uid, client.user.id, 'AI safety block', 'Unsafe custom persona prompt')
            return msg.reply(safetyRefusal(text))
        }
        ai.customPrompts[uid] = text
        if (ai._promptSaveTimer) clearTimeout(ai._promptSaveTimer)
        ai._promptSaveTimer = setTimeout(() => {
            ai._saveJSON('Ai Database/custom_prompts.json', ai.customPrompts)
            ai._promptSaveTimer = null
        }, 500)
        await msg.reply(`✅ Custom prompt set for ${msg.author.displayName}`)
    })
    client.commands.set('prompt', client.commands.get('p'))
    client.commands.set('pr', async (msg) => {
        const uid = String(msg.author.id)
        if (ai.customPrompts[uid]) {
            delete ai.customPrompts[uid]
            ai._saveJSON('Ai Database/custom_prompts.json', ai.customPrompts)
            await msg.reply(`✅ Prompt reset to default for ${msg.author.displayName}`)
        } else await msg.reply("You don't have a custom prompt set.")
    })
    client.commands.set('mode', async (msg, args) => {
        const input = args[0]?.toLowerCase()
        const uid = String(msg.author.id)
        if (!input) {
            const cur = ai.userModes[uid] ?? 0
            return msg.reply(
                `Your current mode: **${cur === 1 ? 'focused' : 'normal'}** (${cur}). Use \`${config.prefix}mode focused\` or \`${config.prefix}mode normal\`.`,
            )
        }
        let newMode = null
        if (['focused', '1'].includes(input)) newMode = 1
        else if (['normal', '0'].includes(input)) newMode = 0
        else return msg.reply('❌ Invalid mode. Use `focused`/`1` or `normal`/`0`')

        ai.userModes[uid] = newMode
        // Async save with debounce to prevent disk thrashing
        if (ai._modeSaveTimer) clearTimeout(ai._modeSaveTimer)
        ai._modeSaveTimer = setTimeout(() => {
            ai._saveJSON('Ai Database/user_modes.json', ai.userModes)
            ai._modeSaveTimer = null
        }, 500)
        return msg.reply(`✅ Switched to **${newMode === 1 ? 'focused' : 'normal'} mode**`)
    })

    client.commands.set(
        'aipause',
        ownerOnly(async (msg) => {
            ai.paused = !ai.paused
            await msg.reply(`AI ${ai.paused ? 'paused' : 'unpaused'}`)
        }),
    )
    client.commands.set(
        'aireinit',
        ownerOnly(async (msg) => {
            ai._initGroq()
            await msg.reply(`Reinitialized. Success: ${!!ai._groq}`)
        }),
    )
    client.commands.set(
        'aiwipe',
        ownerOnly(async (msg) => {
            ai.messageHistory.clear()
            for (const m of [ai.globalMem, ...ai.isolatedMems.values()])
                try {
                    m.db.exec(
                        'DELETE FROM conversations; DELETE FROM interests; DELETE FROM personality; DELETE FROM users; DELETE FROM relationships; DELETE FROM user_aliases;',
                    )
                } catch {}
            await msg.reply('AI memory wiped')
        }),
    )
    client.commands.set(
        'aimodel',
        ownerOnly(async (msg, args) => {
            if (!args[0]) return msg.reply(`Current: \`${ai.aiModel}\``)
            ai.aiModel = args[0]
            saveRuntime({ chatModel: args[0] })
            await msg.reply(`Model set to: \`${args[0]}\``)
        }),
    )
    client.commands.set(
        'aiignore',
        ownerOnly(async (msg, args) => {
            const [action, user] = args
            if (!action) return msg.reply(`Ignored users: ${[...ai.ignoreUsers].join(', ') || 'none'}`)
            if (action === 'add') {
                if (user === 'all') {
                    ai.ignoreUsers.add('all')
                } else {
                    const id = user?.replace(/[<@!>]/g, '')
                    if (id) ai.ignoreUsers.add(id)
                }
                saveRuntime({ ignoreUsers: [...ai.ignoreUsers] })
                await msg.reply('✅ Added')
            } else if (action === 'remove') {
                const id = user?.replace(/[<@!>]/g, '') ?? 'all'
                ai.ignoreUsers.delete(id)
                saveRuntime({ ignoreUsers: [...ai.ignoreUsers] })
                await msg.reply('✅ Removed')
            } else if (action === 'clear') {
                ai.ignoreUsers.clear()
                saveRuntime({ ignoreUsers: [] })
                await msg.reply('✅ Cleared')
            }
        }),
    )
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
    client.commands.set(
        'iso',
        ownerOnly(async (msg) => {
            if (!msg.guild) return
            ai.isolatedServers.add(msg.guild.id)
            ai.isolatedMems.set(msg.guild.id, new AIMemoryManager(msg.guild.id, msg.guild.name))
            saveRuntime({ isolatedGuilds: [...ai.isolatedServers] })
            await msg.reply(`✅ **${msg.guild.name}** isolated — separate AI memory.`)
        }),
    )
    client.commands.set(
        'uniso',
        ownerOnly(async (msg) => {
            if (!msg.guild) return
            ai.isolatedServers.delete(msg.guild.id)
            ai.isolatedMems.delete(msg.guild.id)
            saveRuntime({ isolatedGuilds: [...ai.isolatedServers] })
            await msg.reply(`✅ **${msg.guild.name}** un-isolated.`)
        }),
    )
    client.commands.set(
        'pm',
        ownerOnly(async (msg, args) => {
            const m = args[0]?.toLowerCase()
            if (!m) return msg.reply(`Ping mode: **${ai.pingMode ? 'enabled' : 'disabled'}**`)
            ai.pingMode = ['on', 'enable', 'true', '1'].includes(m)
            saveRuntime({ pingMode: ai.pingMode })
            await msg.reply(`Ping mode **${ai.pingMode ? 'enabled' : 'disabled'}**`)
        }),
    )

    console.log('[AI] Manager initialized, listeners registered')
    return ai
}

// Additional slash commands to add to index.js registration
export function buildAISlashCommands() {
    return [
        new SlashCommandBuilder()
            .setName('lore')
            .setContexts(0)

            .setDescription('Manage server lore Medusa learns from')
            .addSubcommand((s) => s.setName('list').setDescription('View all recorded server lore'))
            .addSubcommand((s) =>
                s
                    .setName('add')
                    .setDescription('Add a lore fact (mods)')
                    .addStringOption((o) =>
                        o.setName('fact').setDescription('Fact to add (max 120 chars)').setRequired(true),
                    ),
            )
            .addSubcommand((s) =>
                s
                    .setName('remove')
                    .setDescription('Remove a lore entry (mods)')
                    .addIntegerOption((o) =>
                        o.setName('id').setDescription('ID from /lore list').setRequired(true),
                    ),
            )
            .addSubcommand((s) => s.setName('clear').setDescription('Clear all auto-extracted lore (mods)')),
        new SlashCommandBuilder()
            .setName('memory')
            .setDescription('See what Medusa remembers about you')
            .setContexts(0),
        new SlashCommandBuilder()
            .setName('forgetme')
            .setContexts(0)
            .setDescription('Delete everything Medusa remembers about you'),
        new SlashCommandBuilder()
            .setName('mode')
            .setContexts(0)
            .setDescription('Switch between focused/normal AI mode')
            .addStringOption((o) =>
                o
                    .setName('mode')
                    .setDescription('focused or normal')
                    .addChoices({ name: 'focused', value: 'focused' }, { name: 'normal', value: 'normal' }),
            ),
        new SlashCommandBuilder()
            .setName('ghost')
            .setContexts(0)
            .setDescription('Manage ghost user filter')
            .addSubcommand((s) =>
                s
                    .setName('add')
                    .setDescription('Ghost a user')
                    .addUserOption((o) =>
                        o.setName('user').setDescription('User to ghost').setRequired(true),
                    ),
            )
            .addSubcommand((s) =>
                s
                    .setName('remove')
                    .setDescription('Unghost a user')
                    .addUserOption((o) =>
                        o.setName('user').setDescription('User to remove').setRequired(true),
                    ),
            )
            .addSubcommand((s) => s.setName('list').setDescription('List ghosted users'))
            .addSubcommand((s) => s.setName('clear').setDescription('Clear ghost list')),
        // Owner-only (hidden by not setting defaultMemberPermissions, ephemeral responses guard access)
        new SlashCommandBuilder().setName('aipause').setDescription('Toggle AI pause (owner)').setContexts(0),
        new SlashCommandBuilder()
            .setName('aireinit')
            .setDescription('Reinitialize Groq client (owner)')
            .setContexts(0),
        new SlashCommandBuilder()
            .setName('aimodel')
            .setContexts(0)
            .setDescription('Get/set AI model (owner)')
            .addStringOption((o) => o.setName('model').setDescription('Model string')),
        new SlashCommandBuilder()
            .setName('aiwipe')
            .setDescription('Wipe all AI memory (owner)')
            .setContexts(0),
        new SlashCommandBuilder()
            .setName('pm')
            .setContexts(0)
            .setDescription('Toggle ping mode (owner)')
            .addStringOption((o) =>
                o
                    .setName('mode')
                    .setDescription('on or off')
                    .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }),
            ),
        new SlashCommandBuilder()
            .setName('iso')
            .setDescription('Isolate server AI memory (owner)')
            .setContexts(0),
        new SlashCommandBuilder()
            .setName('uniso')
            .setDescription('Un-isolate server AI memory (owner)')
            .setContexts(0),
        new SlashCommandBuilder()
            .setName('summarize')
            .setDescription('Summarize recent conversation')
            .setIntegrationTypes(0, 1)
            .setContexts(0, 1, 2)
            .addStringOption((o) => o.setName('start_from').setDescription('Message ID to start from')),
        new SlashCommandBuilder()
            .setName('medusa')
            .setDescription(
                'Quick Agent — stateless AI query, no memory, no commands. Works in DMs and any server.',
            )
            .setIntegrationTypes(0, 1)
            .setContexts(0, 1, 2)
            .addStringOption((o) =>
                o
                    .setName('prompt')
                    .setDescription('What do you want to ask?')
                    .setRequired(true)
                    .setMaxLength(1800),
            )
            .addBooleanOption((o) =>
                o.setName('search').setDescription('Force a live web search (default: auto-detect)'),
            )
            .addBooleanOption((o) =>
                o.setName('private').setDescription('Show only to you (ephemeral). Default: visible.'),
            ),
    ].map((c) => c.toJSON())
}
