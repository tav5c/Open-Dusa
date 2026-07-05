// Agentic command layer: parses <<RUN_CMD: ...>> from model output, enforces
// per-user permission gates and the destructive-action confirmation flow.
import { PermissionFlagsBits } from 'discord.js'
import { VisionCore } from './vision.js'
import { parseWhen } from '../reminders.js'

// LLMs invent CLI/JSON-ish syntax for the reminder command constantly
// (--flag value, key=value, key:value, subcommand verbs). Rather than
// whitelisting each hallucinated shape as it's discovered, parse generically:
// pull out anything that looks like a duration/date field and a message
// field, in whatever shape they're wrapped in, and reduce it to the one
// format the real command understands: "<duration-or-date> <message>".
function extractReminderArgs(argsStr) {
    let s = argsStr.trim().replace(/^(create|add|new|set)\s+/i, '')
    const kv = {}
    for (const m of s.matchAll(/--(\w+)\s+"([^"]*)"|--(\w+)\s+(\S+)/g)) {
        const k = (m[1] ?? m[3]).toLowerCase()
        if (!(k in kv)) kv[k] = m[2] ?? m[4]
    }
    for (const m of s.matchAll(/(\w+)\s*[:=]\s*"([^"]*)"|(\w+)\s*[:=]\s*(\S+)/g)) {
        const k = (m[1] ?? m[3]).toLowerCase()
        if (!(k in kv)) kv[k] = m[2] ?? m[4]
    }
    if (Object.keys(kv).length === 0) return null
    const DUR_KEYS =
        /^(time|delay|in|wait|after|when|due|duration|mins?|minutes?|secs?|seconds?|hours?|hrs?|days?|weeks?)$/i
    const MSG_KEYS = /^(message|text|msg|content|reason|note|what)$/i
    const durKey = Object.keys(kv).find((k) => DUR_KEYS.test(k))
    const msgKey = Object.keys(kv).find((k) => MSG_KEYS.test(k))
    if (!durKey || !msgKey) return null
    const body = kv[msgKey]
    let durVal = kv[durKey]
    if (/^\d+$/.test(durVal)) {
        if (/min/i.test(durKey)) durVal += 'm'
        else if (/hour|hr/i.test(durKey)) durVal += 'h'
        else if (/day/i.test(durKey)) durVal += 'd'
        else if (/week/i.test(durKey)) durVal += 'w'
        else durVal += 's' // delay/wait/time/in/after/when bare numbers -> seconds
    }
    // Absolute dates may arrive with a space ("2026-01-12 00:00:00") -> collapse
    // to ISO-with-T so it survives as a single token once split on whitespace.
    durVal = durVal.replace(/^(\d{4}-\d{2}-\d{2})[ ](\d{2}:\d{2}(:\d{2})?)$/, '$1T$2')
    if (parseWhen(durVal) == null) return null
    return `${durVal} ${body}`
}

export class AgentCommandCore extends VisionCore {
    async _executeParsedCommands(response, message) {
        // Outer <{1,3} / >{1,3} tolerates <<< >>> variants the LLM occasionally emits.
        // Inner \s* before/after args absorbs any extra whitespace the LLM pads in.
        const CMD_PATTERN = /<{2,3}\s*RUN_CMD:\s*([a-zA-Z][a-zA-Z0-9_]*)\s*([\s\S]*?)>{2,3}/g
        // Batch execution: every tag runs, in order — capped so one jailbroken reply
        // can't machine-gun dozens of actions in a single message.
        const MAX_BATCH = 8
        const matches = [...response.matchAll(CMD_PATTERN)].slice(0, MAX_BATCH)
        let finalResponse = response
        // Self-audit: the model declares how many distinct actions it believes
        // it was asked to do. If that's more than the RUN_CMD tags it actually
        // emitted, something got silently dropped mid-generation (the exact
        // failure mode that caused a missing poll despite a confident reply).
        const actionsIntendedMatch = response.match(/<{2,3}\s*ACTIONS_INTENDED:\s*(\d+)\s*>{2,3}/i)
        const actionsIntended = actionsIntendedMatch ? Number(actionsIntendedMatch[1]) : null
        let capturedEmbeds = []
        let executionLogs = []
        let blockedNotes = []

        const origReply = message.reply.bind(message)
        const origSend = message.channel.send.bind(message.channel)

        // Commands the AI may NEVER auto-execute — prefix/owner-only actions.
        // A hallucinated <<RUN_CMD: p some text>> would overwrite the user's custom prompt,
        // <<RUN_CMD: aiwipe>> would nuke all memory, etc. Hard block before any handler lookup.
        const AGENT_BLOCKED = new Set([
            'p',
            'prompt',
            'pr',
            'mode',
            'aipause',
            'aireinit',
            'aiwipe',
            'aimodel',
            'aiignore',
            'aihistory',
            'aiclear',
            'aianalyze',
            'iso',
            'uniso',
            'pm',
            'snake',
            'userinfo',
            'eval',
            'exec',
            'shell',
            'run',
            'system',
            'child_process',
            'require',
            'import',
        ])

        const MOD_CMDS = new Set([
            'ban',
            'kick',
            'mute',
            'unmute',
            'warn',
            'clearwarns',
            'clear',
            'purge',
            'fpurge',
            'mpurge',
            'filter_purge',
            'createchan',
            'delchan',
            'lockchannel',
            'unlockchannel',
            'renameserver',
            'addemoji',
            'setnickname',
            'addrole',
            'removerole',
        ])
        // Per-command permission map — prevents blanket ModerateMembers from granting ban/purge
        const CMD_PERMS = {
            ban: PermissionFlagsBits.BanMembers,
            kick: PermissionFlagsBits.KickMembers,
            mute: PermissionFlagsBits.ModerateMembers,
            unmute: PermissionFlagsBits.ModerateMembers,
            warn: PermissionFlagsBits.ModerateMembers,
            clearwarns: PermissionFlagsBits.ModerateMembers,
            clear: PermissionFlagsBits.ManageMessages,
            purge: PermissionFlagsBits.ManageMessages,
            fpurge: PermissionFlagsBits.ManageMessages,
            mpurge: PermissionFlagsBits.ManageMessages,
            filter_purge: PermissionFlagsBits.ManageMessages,
            createchan: PermissionFlagsBits.ManageChannels,
            delchan: PermissionFlagsBits.ManageChannels,
            lockchannel: PermissionFlagsBits.ManageRoles,
            unlockchannel: PermissionFlagsBits.ManageRoles,
            renameserver: PermissionFlagsBits.ManageGuild,
            addemoji: PermissionFlagsBits.ManageGuildExpressions,
            setnickname: PermissionFlagsBits.ManageNicknames,
            addrole: PermissionFlagsBits.ManageRoles,
            removerole: PermissionFlagsBits.ManageRoles,
        }

        const dummyMsg = {
            edit: async () => dummyMsg,
            delete: async () => {},
            react: async () => {},
            channel: message.channel,
            id: message.id,
        }

        const captureOpts = (opts) => {
            const data = typeof opts === 'string' ? { content: opts } : opts
            if (data.embeds) capturedEmbeds.push(...data.embeds)
            if (data.content) executionLogs.push(data.content.replace(/\n/g, ' ').trim())
        }

        message.reply = async (opts) => {
            captureOpts(opts)
            return dummyMsg
        }
        message.channel.send = async (opts) => {
            captureOpts(opts)
            return dummyMsg
        }

        try {
            for (const match of matches) {
                let cmdName = match[1].toLowerCase()
                // LLMs drift to near-miss reminder command names (set_reminder,
                // create_reminder, remind_me, list_reminders...) constantly. Normalize by
                // intent instead of hardcoding each new guess as it's discovered.
                const REMINDER_CMDS = new Set(['remind', 'reminders', 'delreminder'])
                if (!REMINDER_CMDS.has(cmdName) && /remind/i.test(cmdName)) {
                    if (/list|show|view|check|pending|all/i.test(cmdName)) cmdName = 'reminders'
                    else if (/del|cancel|remove|stop|clear/i.test(cmdName)) cmdName = 'delreminder'
                    else cmdName = 'remind'
                }

                if (AGENT_BLOCKED.has(cmdName)) {
                    console.warn(
                        `[AI] Blocked RUN_CMD '${cmdName}' — prefix-only command, not agent-executable`,
                    )
                    blockedNotes.push(cmdName)
                    continue
                }

                if (MOD_CMDS.has(cmdName)) {
                    const requiredPerm = CMD_PERMS[cmdName]
                    const isOwnerUser = message.author.id === this.ownerId
                    const hasPerm =
                        isOwnerUser || (requiredPerm && message.member?.permissions?.has(requiredPerm))
                    const botHasPerm =
                        !requiredPerm || message.guild?.members.me?.permissions?.has(requiredPerm)

                    if (!hasPerm) {
                        console.warn(`[AI] Blocked unpermitted RUN_CMD '${cmdName}' by ${message.author.id}`)
                        finalResponse = `🔑 You don't have permission to \`${cmdName}\`.`
                        continue
                    }
                    if (!botHasPerm) {
                        console.warn(
                            `[AI] Blocked RUN_CMD '${cmdName}': Bot lacks permission ${requiredPerm}`,
                        )
                        finalResponse = `🛑 I don't have permission to \`${cmdName}\` here.`
                        continue
                    }
                }

                let argsStr = match[2].trim()
                // Normalize typographic characters LLMs love to emit — smart quotes/dashes →
                // ASCII — so otherwise-valid commands aren't rejected for cosmetic reasons.
                argsStr = argsStr
                    .replace(/[\u201C\u201D\u201E]/g, '"')
                    .replace(/[\u2018\u2019]/g, "'")
                    .replace(/[\u2013\u2014]/g, '-')
                // Rescue invented reminder syntax (--flags, key=value, key:value, subcommand
                // verbs) by reducing it to the one shape the real command understands.
                if (cmdName === 'remind') {
                    const rescued = extractReminderArgs(argsStr)
                    if (rescued) argsStr = rescued
                }
                // per-command whitelists everything that isn't explicitly allowed gets dropped.
                // `free` means "any printable text" (announce/dm/poll/topic); these still go through
                // finalSecurityCheck + allowedMentions: parse: [] before sending.
                const FREE_TEXT_CMDS = new Set([
                    'remind',
                    'announce',
                    'dm',
                    'poll',
                    'thread',
                    'topic',
                    'react',
                    'setnickname',
                    'renameserver',
                    'addemoji',
                ])
                const MODE = FREE_TEXT_CMDS.has(cmdName) ? 'free' : 'strict'
                if (MODE === 'strict') {
                    // Strict: IDs, durations, reasons — ASCII word chars + : _ - . , space quotes
                    if (!/^[\w\s.,:'"@#<>!&\-]*$/u.test(argsStr)) {
                        console.warn(
                            `[AI] Blocked RUN_CMD '${cmdName}' — strict arg check failed: ${argsStr.slice(0, 120)}`,
                        )
                        blockedNotes.push(cmdName)
                        continue
                    }
                } else {
                    // Free: forbid null bytes, heredocs, backticks, shell metas, path traversal
                    if (
                        /[`$\\]/.test(argsStr) ||
                        /\x00/.test(argsStr) ||
                        /\.\.\//.test(argsStr) ||
                        /%00/.test(argsStr)
                    ) {
                        console.warn(`[AI] Blocked RUN_CMD '${cmdName}' — unsafe char in free args`)
                        blockedNotes.push(cmdName)
                        continue
                    }
                }
                if (argsStr.length > 1500) {
                    console.warn(`[AI] Blocked RUN_CMD '${cmdName}' — args too long (${argsStr.length})`)
                    blockedNotes.push(cmdName)
                    continue
                }
                const args = argsStr.split(/\s+/).filter(Boolean)

                // Destructive commands require explicit confirmation before firing
                const DESTRUCTIVE = new Set([
                    'ban',
                    'kick',
                    'mute',
                    'mpurge',
                    'clear',
                    'purge',
                    'fpurge',
                    'delchan',
                    'announce',
                    'dm',
                ])
                if (DESTRUCTIVE.has(cmdName)) {
                    // Reject obviously-hallucinated targets before even asking for confirmation.
                    // ban/kick/mute/warn/mpurge need a user snowflake; clear/purge/fpurge need an int count.
                    const needsUserId = [
                        'ban',
                        'kick',
                        'mute',
                        'unmute',
                        'warn',
                        'mpurge',
                        'clearwarns',
                    ].includes(cmdName)
                    const needsInt = ['clear', 'purge', 'fpurge'].includes(cmdName)
                    const rawArg = args[0]?.replace(/[<@!>]/g, '') ?? ''
                    if (needsUserId && !/^\d{15,20}$/.test(rawArg)) {
                        console.warn(
                            `[AI] Blocked hallucinated ${cmdName} — arg '${rawArg}' is not a user ID`,
                        )
                        finalResponse = `❌ I couldn't \`${cmdName}\` them — give me a real @mention or numeric user ID (not a name or "him/her/them"), then I'll do it.`
                        continue
                    }
                    if (needsInt && !/^\d{1,3}$/.test(rawArg)) {
                        console.warn(
                            `[AI] Blocked hallucinated ${cmdName} — arg '${rawArg}' is not a valid count`,
                        )
                        finalResponse = `❌ I couldn't \`${cmdName}\` — that wasn't a valid number of messages.`
                        continue
                    }
                    const targetArg = rawArg.toLowerCase() || 'none'
                    const confirmKey = `${message.author.id}:${cmdName}:${targetArg}:${Date.now()}`
                    // Store full state including original message reference for reply context
                    const existing = this._pendingConfirms.get(confirmKey)
                    const now = Date.now()
                    if (existing && now - existing.ts <= 30_000) {
                        // Already waiting on confirmation — suppress duplicate
                        finalResponse = ''
                        continue
                    }
                    if (!existing || now - existing.ts > 30_000) {
                        for (const [k] of this._pendingConfirms) {
                            if (
                                k.startsWith(`${message.author.id}:${cmdName}:`) &&
                                now - this._pendingConfirms.get(k).ts > 30_000
                            ) {
                                this._pendingConfirms.delete(k)
                            }
                        }
                        // Pre-check: can the bot actually moderate this target?
                        if (cmdName === 'mute') {
                            const rawId = args[0]?.replace(/[<@!>]/g, '')
                            const targetMember = rawId ? message.guild?.members.cache.get(rawId) : null
                            if (targetMember && !targetMember.moderatable) {
                                finalResponse = `❌ I can't mute <@${rawId}> — they're above me in the hierarchy.`
                                continue
                            }
                        }
                        this._pendingConfirms.set(confirmKey, { ts: now, args: argsStr })
                        setTimeout(() => this._pendingConfirms.delete(confirmKey), 35_000)
                        const target =
                            args[0] && /^\d{15,20}$/.test(args[0]) ? `<@${args[0]}>` : (args[0] ?? '')
                        const reason = args.slice(1).join(' ')
                        finalResponse = `⚠️ Confirm \`${cmdName}\`${target ? ` on ${target}` : ''}${reason ? ` — "${reason}"` : ''}? Reply **yes** within 30s.`
                        console.log(`[AI] Confirmation requested for '${cmdName}' by ${message.author.id}`)
                        continue
                    }
                    // Has confirmed within 30s — clear and proceed
                    this._pendingConfirms.delete(confirmKey)
                }

                const handler = this.client.commands?.get(cmdName)

                if (handler) {
                    try {
                        await handler(message, args)
                        console.log(`[AI] Executed '${cmdName}' args='${argsStr}' by ${message.author.id}`)
                    } catch (e) {
                        this.errorCount++
                        console.error('[AI] Auto-exec error:', e)
                    }
                } else {
                    try {
                        if (cmdName === 'poll') {
                            // <<RUN_CMD: poll "Question?" "Answer1" "Answer2" "Answer3">>
                            // NOTE: must use origSend, not message.channel.send — the latter is
                            // monkey-patched for the whole batch to CAPTURE other commands' reply
                            // embeds into the AI's consolidated response, not to actually post. Using
                            // it here silently "succeeded" against a fake object and no poll ever
                            // reached Discord.
                            const parts = [...argsStr.matchAll(/"([^"]+)"/g)].map((m) => m[1])
                            if (parts.length >= 2) {
                                const [question, ...answers] = parts
                                await origSend({
                                    poll: {
                                        question: { text: question.slice(0, 300) },
                                        answers: answers.slice(0, 10).map((a) => ({ text: a.slice(0, 55) })),
                                        duration: 24,
                                        allowMultiselect: false,
                                    },
                                })
                                executionLogs.push(`📊 Poll created: "${question}"`)
                            }
                        } else if (cmdName === 'thread') {
                            // <<RUN_CMD: thread Thread Name Here>>
                            if (argsStr && message.channel.isTextBased()) {
                                const thread = await message.startThread({
                                    name: argsStr.slice(0, 100),
                                    autoArchiveDuration: 1440,
                                })
                                executionLogs.push(`🧵 Thread created: "${thread.name}"`)
                            }
                        } else if (cmdName === 'react') {
                            if (argsStr) await message.react(argsStr.trim()).catch(() => {})
                        } else if (cmdName === 'pin') {
                            const targetId = args[0]
                            if (
                                targetId &&
                                /^\d{15,20}$/.test(targetId) &&
                                message.member?.permissions?.has(PermissionFlagsBits.ManageMessages)
                            ) {
                                const m2 = await message.channel.messages.fetch(targetId).catch(() => null)
                                if (m2) {
                                    await m2.pin().catch(() => {})
                                    executionLogs.push(`📌 Pinned`)
                                }
                            }
                        } else if (cmdName === 'unpin') {
                            const targetId = args[0]
                            if (
                                targetId &&
                                /^\d{15,20}$/.test(targetId) &&
                                message.member?.permissions?.has(PermissionFlagsBits.ManageMessages)
                            ) {
                                const m2 = await message.channel.messages.fetch(targetId).catch(() => null)
                                if (m2) {
                                    await m2.unpin().catch(() => {})
                                    executionLogs.push(`📌 Unpinned`)
                                }
                            }
                        } else if (cmdName === 'slowmode') {
                            const secs = Math.min(parseInt(args[0]) || 0, 21600)
                            if (
                                message.channel.isTextBased() &&
                                message.member?.permissions?.has('ManageChannels')
                            ) {
                                await message.channel.setRateLimitPerUser(secs)
                                executionLogs.push(`🐢 Slowmode: ${secs}s`)
                            }
                        } else if (cmdName === 'topic') {
                            if (
                                argsStr &&
                                message.channel.isTextBased() &&
                                message.member?.permissions?.has('ManageChannels')
                            ) {
                                await message.channel.setTopic(argsStr.slice(0, 1024))
                                executionLogs.push(`📝 Topic updated`)
                            }
                        } else if (cmdName === 'announce') {
                            const chanId = args[0]
                            const body = args.slice(1).join(' ')
                            if (chanId && /^\d{15,20}$/.test(chanId) && body) {
                                const chan = message.guild?.channels.cache.get(chanId)
                                if (
                                    chan?.isTextBased() &&
                                    message.member?.permissions?.has('ManageMessages')
                                ) {
                                    await chan.send({ content: body, allowedMentions: { parse: [] } })
                                    executionLogs.push(`📢 Announced to #${chan.name}`)
                                }
                            }
                        } else if (cmdName === 'movevc') {
                            const [uid, cid] = args
                            const botHasPerm = message.guild?.members.me?.permissions.has('MoveMembers')
                            if (uid && cid && message.member?.permissions?.has('MoveMembers') && botHasPerm) {
                                const target = await message.guild?.members.fetch(uid).catch(() => null)
                                const chan = message.guild?.channels.cache.get(cid)
                                if (target?.voice?.channel && chan) {
                                    await target.voice.setChannel(chan)
                                    executionLogs.push(`🔊 Moved to ${chan.name}`)
                                }
                            }
                        } else if (cmdName === 'dm') {
                            if (message.author.id === this.ownerId) {
                                const uid = args[0]
                                const body = args.slice(1).join(' ')
                                if (uid && body) {
                                    const user = await this.client.users.fetch(uid).catch(() => null)
                                    if (user) {
                                        await user.send(body).catch(() => {})
                                        executionLogs.push(`📨 DM sent`)
                                    }
                                }
                            }
                        } else {
                            console.warn(`[AI] Ignored RUN_CMD '${cmdName}' — not a recognized command`)
                            blockedNotes.push(cmdName)
                        }
                    } catch (e) {
                        this.errorCount++
                        console.error('[AI] Virtual cmd error:', e)
                    }
                }
            }
        } finally {
            message.reply = origReply
            message.channel.send = origSend
        }

        // Format all executions cleanly
        if (executionLogs.length > 0) {
            finalResponse += `\n\n*-# ⚙️ ${executionLogs.join(' · ')}*`
        }
        // Honesty guard: if anything was blocked/ignored, say so visibly — otherwise
        // the model's own prose ("Reminder set!") ships as a false success claim.
        if (blockedNotes.length > 0) {
            finalResponse += `\n\n*-# ⚠️ \`${[...new Set(blockedNotes)].join('`, `')}\` didn't go through — try rephrasing.*`
        }
        // Self-audit follow-through: the model planned for more actions than it
        // actually attempted (no RUN_CMD tag at all for the missing one/s), so
        // there's nothing in executionLogs/blockedNotes to catch it. Surface the
        // gap explicitly instead of ending the reply looking fully complete.
        if (actionsIntended !== null && actionsIntended > matches.length) {
            finalResponse += `\n\n*-# 📋 Heads up — I planned ${actionsIntended} action${actionsIntended === 1 ? '' : 's'} but only attempted ${matches.length}. Something may have gotten dropped — let me know what's missing and I'll redo it.*`
        }
        let cleanedText = finalResponse
            .replace(/<{2,3}\s*RUN_CMD:\s*[\s\S]*?>{2,3}[>\s]*/g, '')
            .replace(/<{2,3}\s*ACTIONS_INTENDED:\s*\d+\s*>{2,3}/gi, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim()
        return {
            text: cleanedText,
            embeds: capturedEmbeds,
        }
    }
    _matchProfileVisual(prompt, userId, message) {
        const bareMsg = (prompt.match(/\nUser's message:\s*([\s\S]+)$/)?.[1] ?? prompt).toLowerCase().trim()
        // Find a mentioned user (excluding the bot), else fall back to the author
        const mentionedId = message?.mentions?.users
            ? [...message.mentions.users.keys()].find((id) => id !== this.client.user.id)
            : null
        const targetId = mentionedId ?? userId

        const OWNERSHIP = /\b(my|your|their|his|her)\b/i
        const VISUAL_VERB =
            /\b(show|see|display|send|get|pull up|share|post|what(?:'s| is| does)|can you|could you|look at)\b/i
        const AVATAR_WORDS = /\b(avatar|pfp|profile\s*pic(?:ture)?|icon)\b/i
        const BANNER_WORDS = /\b(banner|profile\s*banner|discord\s*banner)\b/i

        const hasOwnership = OWNERSHIP.test(bareMsg) || !!mentionedId
        const hasIntent = VISUAL_VERB.test(bareMsg) || !!mentionedId

        // Require ownership indicator + visual intent to avoid false positives
        // e.g. "I don't like my avatar" should NOT trigger; "show my avatar" should
        if (!hasOwnership || !hasIntent) return null

        if (BANNER_WORDS.test(bareMsg)) {
            const isServer = /\b(server|guild|local)\b/i.test(bareMsg)
            return `here you go 💜 <<RUN_CMD: ${isServer ? 'bn' : 'mbn'} ${targetId}>>`
        }
        if (AVATAR_WORDS.test(bareMsg)) return `here you go ✨ <<RUN_CMD: av ${targetId}>>`
        return null
    }
}
