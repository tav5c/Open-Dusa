// Agentic command layer: parses <<RUN_CMD: ...>> from model output, enforces
// per-user permission gates and the destructive-action confirmation flow.
import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType,
    EmbedBuilder,
    MessageFlags,
    ModalBuilder,
    PermissionFlagsBits,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    TextInputBuilder,
    TextInputStyle,
} from 'discord.js'
import { VisionCore } from './vision.js'
import { DESTRUCTIVE_CMDS, INT_COUNT_CMDS, SENSITIVE_CMDS, USER_TARGET_CMDS } from './constants.js'
import { parseWhen } from '../reminders.js'

// Module-scope command metadata: shared by _executeParsedCommands (gates +
// confirm flow) and _runConfirmedCommand (perm re-check at execution time), so
// the two can never disagree about what a command needs.
export const MOD_CMDS = new Set([
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
    'createchan',
    'delchan',
    'lockchannel',
    'unlockchannel',
    'renameserver',
    'addemoji',
    'setnickname',
    'addrole',
    'removerole',
    'createrole',
])
const VIRTUAL_CMDS = new Set([
    'poll',
    'thread',
    'react',
    'pin',
    'unpin',
    'slowmode',
    'topic',
    'announce',
    'mail',
    'movevc',
    'dm',
])
// Per-command permission map, prevents blanket ModerateMembers from granting ban/purge
export const CMD_PERMS = {
    ban: PermissionFlagsBits.BanMembers,
    unban: PermissionFlagsBits.BanMembers,
    kick: PermissionFlagsBits.KickMembers,
    mute: PermissionFlagsBits.ModerateMembers,
    unmute: PermissionFlagsBits.ModerateMembers,
    warn: PermissionFlagsBits.ModerateMembers,
    clearwarns: PermissionFlagsBits.ModerateMembers,
    clear: PermissionFlagsBits.ManageMessages,
    purge: PermissionFlagsBits.ManageMessages,
    fpurge: PermissionFlagsBits.ManageMessages,
    mpurge: PermissionFlagsBits.ManageMessages,
    createchan: PermissionFlagsBits.ManageChannels,
    delchan: PermissionFlagsBits.ManageChannels,
    lockchannel: PermissionFlagsBits.ManageRoles,
    unlockchannel: PermissionFlagsBits.ManageRoles,
    renameserver: PermissionFlagsBits.ManageGuild,
    addemoji: PermissionFlagsBits.ManageGuildExpressions,
    setnickname: PermissionFlagsBits.ManageNicknames,
    addrole: PermissionFlagsBits.ManageRoles,
    removerole: PermissionFlagsBits.ManageRoles,
    createrole: PermissionFlagsBits.ManageRoles,
}
// One-line consequence blurbs for confirm embeds: what does what, for what.
const CONFIRM_CONSEQUENCE = {
    ban: 'They will be removed from the server and must be unbanned to return.',
    unban: 'They will be allowed back with a fresh invite.',
    kick: 'They will be removed but can rejoin right away.',
    mute: 'They will be timed out and unable to speak.',
    unmute: 'Their timeout will end early.',
    warn: 'A strike goes on their record.',
    clear: 'Messages will be permanently deleted.',
    purge: 'Messages will be permanently deleted.',
    fpurge: 'Matching messages will be permanently deleted.',
    mpurge: "That user's recent messages will be wiped.",
    delchan: 'The channel will be permanently deleted.',
    announce: 'A message will post publicly in that channel.',
    createrole: 'A new role will be created on this server.',
    mail: 'A private note goes to the bot owner.',
    dm: 'A DM will be sent as the bot.',
}

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
    // Best-effort mention-free target resolution for agent commands.
    // Returns a snowflake ID or null. Pronouns resolve to the replied-to author;
    // names match username/displayName/nickname (exact first, then unique substring,
    // then a live API search for big rosters whose offline members aren't cached).
    // Ambiguous or missing matches return null so the caller asks for a mention.
    async _resolveMemberId(message, raw) {
        const clean = String(raw ?? '')
            .replace(/[<@!>]/g, '')
            .trim()
        if (/^\d{15,20}$/.test(clean)) return clean
        const guild = message?.guild
        if (!guild) return null
        if (/^(him|her|them|they|this (guy|user|person)|that (guy|user|person)|the user)$/i.test(clean)) {
            const refAuthor =
                message.reference?.resolved?.author ?? message._medusaReplyCtx?.ref?.author ?? null
            if (refAuthor && !refAuthor.bot && refAuthor.id !== this.client?.user?.id) return refAuthor.id
            return null
        }
        if (clean.length < 2) return null
        const lower = clean.toLowerCase()
        // Unicode fold: stylized display names ("𝓐𝓭𝓲", "ａｄｉ", "ⒶⒹⒾ")
        // NFKD-decompose to ASCII so every stage below compares folded forms.
        // Plain ASCII folds to itself — zero behavior change for normal names.
        const fold = (s) =>
            String(s ?? '')
                .normalize('NFKD')
                .replace(/[\u0300-\u036f\ufe00-\ufe0f]/g, '')
                .toLowerCase()
                .replace(/[^a-z0-9]/g, '')
        const qn = fold(clean)
        const names = (m) =>
            [m.user?.username, m.user?.globalName, m.displayName, m.nickname]
                .filter(Boolean)
                .map((n) => String(n).toLowerCase())
        const cacheMembers = [...(guild.members.cache?.values() ?? [])]
        const exact = cacheMembers.filter((m) =>
            names(m).some((n) => n === lower || n.replace(/^@/, '') === lower || (qn && fold(n) === qn)),
        )
        if (exact.length === 1) return exact[0].id
        if (exact.length > 1) return null
        // Substring matches only at a word start ("tony" ⊂ "xx_tonyfan" yes,
        // "rick" ⊂ "prick" no) — same wrong-direction guard as fuzzy below.
        const partial = cacheMembers.filter((m) =>
            names(m).some((n) => {
                const s = String(n).toLowerCase()
                let i = s.indexOf(lower)
                while (i !== -1) {
                    if (i === 0 || !/[a-z0-9]/.test(s[i - 1])) return true
                    i = s.indexOf(lower, i + 1)
                }
                // Folded retry: stylized names ("𝓐𝓭𝓲") never contain the raw
                // query, but their ASCII fold does. Same word-start guard.
                if (qn) {
                    const f = fold(n)
                    let j = f.indexOf(qn)
                    while (j !== -1) {
                        if (j === 0 || !/[a-z0-9]/.test(f[j - 1])) return true
                        j = f.indexOf(qn, j + 1)
                    }
                }
                return false
            }),
        )
        if (partial.length === 1) return partial[0].id
        if (partial.length > 1) return null
        // Learned aliases ("call me X") live in memory, not on the roster.
        try {
            const aliasHit = this.client?.aiCog?.getMem?.(guild)?.getUserIdByAlias?.(lower)
            if (aliasHit) return aliasHit
        } catch {}
        // Fuzzy: stylized spellings ("t0n9y" for "tony"). Bounded edit distance,
        // unique best only, never for very short queries. First character must
        // match: without that, "kick rick" resolves to a "prick" who merely shares
        // letters — the one wrong-direction case that can harm a real user.
        if (lower.length >= 4) {
            const norm = (s) => fold(s ?? '')
            const q = qn || norm(lower)
            const levCap = (x, y, cap) => {
                if (Math.abs(x.length - y.length) > cap) return cap + 1
                let prev = Array.from({ length: y.length + 1 }, (_, j) => j)
                for (let i = 1; i <= x.length; i++) {
                    const cur = [i]
                    let rowMin = i
                    for (let j = 1; j <= y.length; j++) {
                        const v = Math.min(
                            prev[j] + 1,
                            cur[j - 1] + 1,
                            prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1),
                        )
                        cur.push(v)
                        if (v < rowMin) rowMin = v
                    }
                    if (rowMin > cap) return cap + 1
                    prev = cur
                }
                return prev[y.length]
            }
            const hits = new Map()
            for (const m of cacheMembers) {
                for (const n of names(m)) {
                    const nn = norm(n)
                    if (!nn || !q || nn[0] !== q[0]) continue
                    const d = levCap(q, nn, 2)
                    if (d <= 2 && (!hits.has(m.id) || hits.get(m.id) > d)) hits.set(m.id, d)
                }
            }
            if (hits.size === 1) return [...hits.keys()][0]
        }
        // Cache miss on a big roster (offline members aren't cached): ask the API.
        // Same first-character guard as above, so server-side substring matching
        // can't hand back a wrong-direction member either.
        try {
            const found = await guild.members.fetch({ query: clean.slice(0, 100), limit: 5 })
            const list = [...found.values()].filter((m) =>
                [m.user?.username, m.user?.globalName, m.displayName, m.nickname]
                    .filter(Boolean)
                    .map((n) => fold(n))
                    .some((nn) => nn && qn && nn[0] === qn[0]),
            )
            const exactApi = list.filter((m) =>
                [m.user?.username, m.user?.globalName, m.displayName, m.nickname]
                    .filter(Boolean)
                    .map((n) => String(n).toLowerCase())
                    .some((n) => n === lower),
            )
            // Require a UNIQUE exact match, same as the cache path: two members
            // sharing a display name must not resolve to whichever the API
            // happened to list first.
            if (exactApi.length === 1) return exactApi[0].id
            if (exactApi.length > 1) return null
            if (list.length === 1) return list[0].id
        } catch {}
        return null
    }

    // Shared confirm UI: the embed (what, on whom, why, consequence) and the
    // Confirm/Cancel/Reason row. Used by the confirmUI parts and the modal-submit
    // handler in ai.js so both render identically.
    buildConfirmRow(cmdName, targetArg) {
        return new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`mcfm:yes:${cmdName}:${targetArg}`)
                .setLabel('Confirm')
                .setStyle(ButtonStyle.Success)
                .setEmoji('✅'),
            new ButtonBuilder()
                .setCustomId(`mcfm:no:${cmdName}:${targetArg}`)
                .setLabel('Cancel')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('❌'),
            new ButtonBuilder()
                .setCustomId(`mcfm:rsn:${cmdName}:${targetArg}`)
                .setLabel('Reason')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('✏️'),
        )
    }
    buildConfirmEmbed(cmdName, targetArg, reason, authorId) {
        const targetMention = /^\d{15,20}$/.test(targetArg ?? '')
            ? `<@${targetArg}>`
            : targetArg && targetArg !== 'none'
              ? `\`${targetArg}\``
              : ''
        return new EmbedBuilder()
            .setTitle(`Confirm ${cmdName}`)
            .setDescription(
                [
                    targetMention ? `Target: ${targetMention}` : null,
                    reason ? `Reason: "${String(reason).slice(0, 200)}"` : null,
                    CONFIRM_CONSEQUENCE[cmdName] ?? 'This action will run as requested.',
                    `Only <@${authorId}> can decide — tap ✅ / ❌ / ✏️, or reply yes / no.`,
                ]
                    .filter(Boolean)
                    .join('\n'),
            )
            .setColor(0xef9f27)
            .setFooter({ text: 'Expires in 30s' })
    }
    // Cancel/expiry paper trail: a declined or expired confirm must leave an
    // explicit "nothing was executed" record in short-term history. Without
    // it the model later reconstructs ask → "on it" → user satisfaction as
    // a completed action ("I already muted Adi" after a cancel).
    _recordConfirmOutcome(key, message, outcome) {
        try {
            const [, cmdName, target] = String(key).split(':')
            const who = /^\d{15,20}$/.test(target ?? '') ? `<@${target}>` : target || 'that action'
            const hk = `${message.author.id}-${message.channel.id}`
            this.messageHistory ??= new Map()
            const hist = this.messageHistory.get(hk) ?? []
            hist.push({
                role: 'assistant',
                content: `(${cmdName} ${who} was ${outcome} — nothing was executed.)`,
            })
            this.messageHistory.set(hk, hist)
        } catch {}
    }
    // Collector wiring for an already-posted confirm UI message. Called by
    // chat.js right after the UI send succeeds, so buttons never exist
    // untracked. Single message carries text note + embed + row: it lands
    // together or fails loudly together — no more text-without-buttons state.
    async _watchConfirmUI(sent, confirmKey, message) {
        try {
            const col = sent.createMessageComponentCollector({
                componentType: ComponentType.Button,
                time: 35_000,
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
                    const parts = String(i.customId ?? '').split(':')
                    const decision = parts[1]
                    const key = `${message.author.id}:${parts[2] ?? ''}:${parts.slice(3).join(':')}`
                    // Reason button: pop a modal, the submit handler (ai.js) updates
                    // the pending args and refreshes this embed in place.
                    if (decision === 'rsn') {
                        const modal = new ModalBuilder()
                            .setCustomId(`mcfm-rsn:${parts[2] ?? ''}:${parts.slice(3).join(':')}`)
                            .setTitle(`Reason for ${parts[2] ?? 'action'}`.slice(0, 45))
                            .addComponents(
                                new ActionRowBuilder().addComponents(
                                    new TextInputBuilder()
                                        .setCustomId('reason')
                                        .setLabel('Reason')
                                        .setStyle(TextInputStyle.Paragraph)
                                        .setRequired(true)
                                        .setMaxLength(300),
                                ),
                            )
                        await i.showModal(modal).catch(() => {})
                        return
                    }
                    const val = this._pendingConfirms.get(key)
                    col.stop()
                    if (!val || Date.now() - val.ts > 30_000) {
                        await i
                            .update({
                                content: '⌛ Expired — ask again if you still want it.',
                                embeds: [],
                                components: [],
                            })
                            .catch(() => {})
                        this._recordConfirmOutcome(key, message, 'expired')
                        return
                    }
                    this._pendingConfirms.delete(key)
                    if (decision === 'no') {
                        await i.update({ content: 'Cancelled.', embeds: [], components: [] }).catch(() => {})
                        await message.react('❌').catch(() => {})
                        this._recordConfirmOutcome(key, message, 'cancelled')
                        return
                    }
                    await i
                        .update({
                            content: `✅ Confirmed \`${parts[2]}\` — running it now.`,
                            embeds: [],
                            components: [],
                        })
                        .catch(() => {})
                    await this._runConfirmedCommand(key, val, message)
                } catch (e) {
                    console.error('[AI] Confirm button error:', e)
                }
            })
            col.on('end', async () => {
                try {
                    // Disarm these buttons always; then sweep (which re-arms itself
                    // while a refresh keeps the entry fresh, so abandoned refreshes
                    // still garbage-collect).
                    await sent.edit({ components: [] }).catch(() => {})
                    this._sweepConfirm(confirmKey, 0)
                } catch {}
            })
        } catch (e) {
            console.error('[AI] Confirm UI watch failed:', e)
        }
    }
    // Expiry with refresh-awareness: a refreshed pending (repeat ask / reason
    // modal) owns a fresh 30s window, so blind deletion at t0+35s is wrong.
    // Re-arms while the entry stays fresh so abandoned refreshes still
    // garbage-collect instead of leaking one map entry each.
    _sweepConfirm(confirmKey, delayMs = 35_000) {
        setTimeout(() => {
            const v = this._pendingConfirms.get(confirmKey)
            if (!v) return
            if (Date.now() - v.ts >= 30_000) {
                this._pendingConfirms.delete(confirmKey)
                return
            }
            this._sweepConfirm(confirmKey, 10_000)
        }, delayMs).unref()
    }
    async _executeParsedCommands(response, message) {
        // Outer <{1,3} / >{1,3} tolerates <<< >>> variants the LLM occasionally emits.
        // Inner \s* before/after args absorbs any extra whitespace the LLM pads in.
        const CMD_PATTERN = /<{2,3}\s*RUN_CMD:\s*([a-zA-Z][a-zA-Z0-9_]*)\s*([\s\S]*?)>{2,3}/g
        // Batch execution: every tag runs, in order, capped so one jailbroken reply
        // can't machine-gun dozens of actions in a single message.
        const MAX_BATCH = 8
        const matches = [...response.matchAll(CMD_PATTERN)].slice(0, MAX_BATCH)
        // Repeat-offender gate: someone hammering blocked commands gets cut off for a
        // cooldown window instead of a fresh attempt + warning footer every message.
        const streak = this._blockedStreaks?.get(message.author.id)
        if (matches.length && streak && streak.count >= 5 && Date.now() - streak.at < 300_000) {
            return {
                text: "nope. you've burned enough blocked attempts for one sitting, give it a few minutes 💜",
                embeds: [],
                confirmPending: false,
                sensitive: false,
            }
        }
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
        let modExecuted = false
        let confirmNote = null
        // confirmUI carries the button row + embed to chat.js, which sends them
        // on the SAME message as the note text: both land together or the send
        // fails loudly together. Never a text promise without buttons again.
        let confirmUI = null
        // Privacy window: read-only lookups (recall) auto-delete from chat.
        let sensitive = false

        const origReply = message.reply.bind(message)
        const origSend = message.channel.send.bind(message.channel)

        // Commands the AI may NEVER auto-execute, prefix/owner-only actions.
        // A hallucinated <<RUN_CMD: p some text>> would overwrite the user's custom prompt,
        // <<RUN_CMD: aihistory>> would dump someone's chat history, etc. Hard block before any handler lookup.
        const AGENT_BLOCKED = new Set([
            'p',
            'prompt',
            'pr',
            'mode',
            'ai-pause',
            'aihistory',
            'aiclear',
            'aianalyze',
            'isolation',
            'configclean',
            'snake',
            'eval',
            'exec',
            'shell',
            'run',
            'system',
            'child_process',
            'require',
            'import',
        ])

        // Command metadata (MOD_CMDS, VIRTUAL_CMDS, CMD_PERMS) lives at module
        // scope so _runConfirmedCommand's perm re-check agrees with these gates.
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
                // Same drift for dm/mail: send_dm, senddm, send_mail...
                if (/^send_?(dm|mail)$/i.test(cmdName)) cmdName = cmdName.replace(/^send_?/i, '')
                if (SENSITIVE_CMDS.has(cmdName)) sensitive = true

                if (AGENT_BLOCKED.has(cmdName)) {
                    console.warn(
                        `[AI] Blocked RUN_CMD '${cmdName}', prefix-only command, not agent-executable`,
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

                if (!this.client.commands?.has(cmdName) && !VIRTUAL_CMDS.has(cmdName)) {
                    console.warn(`[AI] Ignored unknown RUN_CMD '${cmdName}'`)
                    blockedNotes.push(cmdName)
                    continue
                }

                let argsStr = match[2].trim()
                // Normalize typographic characters LLMs love to emit, smart quotes/dashes ->
                // ASCII, so otherwise-valid commands aren't rejected for cosmetic reasons.
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
                // Same rescue for dm/mail: user_id=123 content="hi" -> "123 hi".
                if ((cmdName === 'dm' || cmdName === 'mail') && /^\s*\w+\s*[:=]/.test(argsStr)) {
                    const kv = {}
                    for (const m of argsStr.matchAll(/(\w+)\s*[:=]\s*"([^"]*)"|(\w+)\s*[:=]\s*(\S+)/g)) {
                        const k = (m[1] ?? m[3]).toLowerCase()
                        if (!(k in kv)) kv[k] = m[2] ?? m[4]
                    }
                    const target = Object.keys(kv).find((k) =>
                        /^(user_?id|user|target|recipient|to|id)$/i.test(k),
                    )
                    const body = Object.keys(kv).find((k) => /^(content|message|msg|text|body)$/i.test(k))
                    if (target && body) argsStr = `${kv[target]} ${kv[body]}`
                }
                // per-command whitelists everything that isn't explicitly allowed gets dropped.
                // `free` means "any printable text" (announce/dm/poll/topic); these still go through
                // finalSecurityCheck + allowedMentions: parse: [] before sending.
                const FREE_TEXT_CMDS = new Set([
                    'remind',
                    'announce',
                    'mail',
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
                    // Strict: IDs, durations, reasons, ASCII word chars + : _ - . , space quotes
                    if (!/^[\w\s.,:'"@#<>!&\-]*$/u.test(argsStr)) {
                        console.warn(
                            `[AI] Blocked RUN_CMD '${cmdName}', strict arg check failed: ${argsStr.slice(0, 120)}`,
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
                        console.warn(`[AI] Blocked RUN_CMD '${cmdName}', unsafe char in free args`)
                        blockedNotes.push(cmdName)
                        continue
                    }
                }
                if (argsStr.length > 1500) {
                    console.warn(`[AI] Blocked RUN_CMD '${cmdName}', args too long (${argsStr.length})`)
                    blockedNotes.push(cmdName)
                    continue
                }
                const args = argsStr.split(/\s+/).filter(Boolean)

                // Destructive commands require explicit confirmation before firing.
                // Sets live in constants.js (shared with chat.js's streaming gate).
                if (DESTRUCTIVE_CMDS.has(cmdName)) {
                    // Reject obviously-hallucinated targets before even asking for confirmation.
                    // USER_TARGET_CMDS need a user snowflake (names resolve above); INT_COUNT_CMDS need an int count.
                    const needsUserId = USER_TARGET_CMDS.has(cmdName)
                    const needsInt = INT_COUNT_CMDS.has(cmdName)
                    let rawArg = args[0]?.replace(/[<@!>]/g, '') ?? ''
                    // Name/pronoun resolution: mods say "mute tony" or reply "mute him",
                    // not snowflakes. Resolve against the roster (or the replied-to
                    // author for pronouns) and rewrite to the ID so the checks below,
                    // the confirm key, and the handler all see the real target.
                    if (needsUserId && !/^\d{15,20}$/.test(rawArg)) {
                        const resolvedId = await this._resolveMemberId(message, args[0] ?? '')
                        if (resolvedId) {
                            args[0] = resolvedId
                            argsStr = args.join(' ')
                            rawArg = resolvedId
                        }
                    }
                    if (needsUserId && !/^\d{15,20}$/.test(rawArg)) {
                        console.warn(
                            `[AI] Blocked ${cmdName}, could not resolve target '${args[0] ?? ''}' to a member`,
                        )
                        finalResponse = `❌ I couldn't find them — give me a @mention, exact username, or reply to their message, then I'll \`${cmdName}\`.`
                        continue
                    }
                    if (needsInt && !/^\d{1,3}$/.test(rawArg)) {
                        console.warn(
                            `[AI] Blocked hallucinated ${cmdName}, arg '${rawArg}' is not a valid count`,
                        )
                        finalResponse = `❌ I couldn't \`${cmdName}\`, that wasn't a valid number of messages.`
                        continue
                    }
                    const targetArg = (rawArg.toLowerCase() || 'none').slice(0, 60)
                    const confirmKey = `${message.author.id}:${cmdName}:${targetArg}`
                    const approved = this._approvedConfirms?.delete(confirmKey) === true
                    // Store full state including original message reference for reply context
                    const existing = this._pendingConfirms.get(confirmKey)
                    const now = Date.now()
                    // Confirm-note text, shared by the fresh and refreshed paths below.
                    const target =
                        cmdName === 'announce'
                            ? (args[0] ?? '').replace(/^<#(\d{15,20})>$/, '<#$1>')
                            : args[0] && /^\d{15,20}$/.test(args[0])
                              ? `<@${args[0]}>`
                              : (args[0] ?? '')
                    const reason = args.slice(1).join(' ')
                    // In-character confirm: the model's own prose stays untouched,
                    // this rides after it (tags stripped below) instead of replacing
                    // everything with one generic robot line. Buttons ride on the
                    // SAME send as this note (see confirmUI below), so tap-✅ is
                    // always safe to promise: both land together or fail loudly.
                    const closers = [
                        "say **yes** (or tap ✅) within 30s and it's done.",
                        "yes or no — or tap ✅ / ❌. you've got 30s before i lose interest.",
                        '**yes** (or ✅) in the next 30s, or it never happened.',
                    ]
                    const noteBase = `you want me to \`${cmdName}\`${target ? ` on ${target}` : ''}${reason ? ` — "${reason}"` : ''}?`
                    const closer = closers[confirmKey.length % closers.length]
                    // UI parts travel with the reply text (built by chat.js into one
                    // send). Set on fresh setup, and on refresh only when no tracked
                    // UI message exists yet.
                    const uiParts = () => ({
                        key: confirmKey,
                        row: this.buildConfirmRow(cmdName, targetArg),
                        embed: this.buildConfirmEmbed(cmdName, targetArg, reason, message.author.id),
                    })
                    if (approved) {
                        this._pendingConfirms.delete(confirmKey)
                    } else {
                        if (existing && now - existing.ts <= 30_000) {
                            // Same ask while one pends: refresh the stored args (the user
                            // may have corrected the reason). Update the tracked UI
                            // message in place when there is one; re-note (with fresh
                            // buttons only if none were ever posted) at most every 5s
                            // so rapid repeats don't spam the channel.
                            existing.args = argsStr
                            existing.ts = now
                            if (existing.uiMsg) {
                                try {
                                    await existing.uiMsg
                                        .edit({
                                            embeds: [
                                                this.buildConfirmEmbed(
                                                    cmdName,
                                                    targetArg,
                                                    reason,
                                                    message.author.id,
                                                ),
                                            ],
                                            components: [this.buildConfirmRow(cmdName, targetArg)],
                                        })
                                        .catch(() => {})
                                } catch {}
                            }
                            if (!existing.noteTs || now - existing.noteTs > 5000) {
                                existing.noteTs = now
                                if (!existing.uiMsg) confirmUI = uiParts()
                                confirmNote = `🔄 updated — ${noteBase} ${closer}`
                                console.log(
                                    `[AI] Confirmation refreshed for '${cmdName}' by ${message.author.id}`,
                                )
                            }
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
                                    finalResponse = `❌ I can't mute <@${rawId}>, they're above me in the hierarchy.`
                                    continue
                                }
                            }
                            this._pendingConfirms.set(confirmKey, { ts: now, args: argsStr, noteTs: now })
                            // Hard expiry respects refreshes via _sweepConfirm (re-arms
                            // while fresh so abandoned refreshes still GC).
                            this._sweepConfirm(confirmKey)
                            confirmNote = `⏳ ${noteBase} ${closer}`
                            confirmUI = uiParts()
                            console.log(
                                `[AI] Confirmation requested for '${cmdName}' by ${message.author.id}`,
                            )
                            continue
                        }
                        // Has confirmed within 30s, clear and proceed
                        this._pendingConfirms.delete(confirmKey)
                    }
                }

                const handler = this.client.commands?.get(cmdName)

                if (handler) {
                    try {
                        await handler(message, args)
                        if (MOD_CMDS.has(cmdName)) modExecuted = true
                        console.log(`[AI] Executed '${cmdName}' args='${argsStr}' by ${message.author.id}`)
                    } catch (e) {
                        this.errorCount++
                        console.error('[AI] Auto-exec error:', e)
                    }
                } else {
                    try {
                        if (cmdName === 'poll') {
                            // <<RUN_CMD: poll "Question?" "Answer1" "Answer2" "Answer3">>
                            // NOTE: must use origSend, not message.channel.send, the latter is
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
                            const rawTarget = args[0] ?? ''
                            const mentionedId = rawTarget.match(/^<#(\d{15,20})>$/)?.[1]
                            const numericId = /^\d{15,20}$/.test(rawTarget) ? rawTarget : mentionedId
                            const name = rawTarget.replace(/^#/, '').toLowerCase()
                            const chan = numericId
                                ? message.guild?.channels.cache.get(numericId)
                                : message.guild?.channels.cache.find((c) => c.name?.toLowerCase() === name)
                            const body = args.slice(1).join(' ')
                            if (!message.member?.permissions?.has(PermissionFlagsBits.ManageMessages))
                                finalResponse = '🔑 You need Manage Messages to announce.'
                            else if (!body) finalResponse = '❌ Give me a channel and announcement text.'
                            else if (!chan)
                                finalResponse = `❌ I couldn't find channel ${rawTarget || '(missing)'}.`
                            else if (!chan.isTextBased() || !chan.isSendable())
                                finalResponse = `❌ #${chan.name} can't accept messages.`
                            else {
                                const userIds = [...body.matchAll(/<@!?(\d{15,20})>/g)].map((m) => m[1])
                                await chan.send({
                                    content: body,
                                    allowedMentions: { users: [...new Set(userIds)], parse: [] },
                                })
                                executionLogs.push(`📢 Announced to #${chan.name}`)
                            }
                        } else if (cmdName === 'mail') {
                            if (!argsStr) finalResponse = '❌ Tell me what to send Tav.'
                            else if (typeof this.client.sendDeveloperMail !== 'function')
                                finalResponse = '❌ Mail is unavailable right now.'
                            else {
                                const result = await this.client.sendDeveloperMail(message, argsStr)
                                if (result.ok) executionLogs.push(`📬 Mail sent to Tav`)
                                else finalResponse = `❌ Mail failed: ${result.error}`
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
                            console.warn(`[AI] Ignored RUN_CMD '${cmdName}', not a recognized command`)
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

        // Honesty guard for prose enforcement claims ("User @X has been warned…"):
        // the permission gates above only cover real <<RUN_CMD>> tags, which is how
        // slang like "murk tony" turned into a fake warning with zero DB writes.
        // If no moderation command actually executed this turn, those sentences are
        // fiction — strip them and say so instead of shipping a false penalty.
        if (!modExecuted) {
            const before = finalResponse
            finalResponse = finalResponse
                .replace(
                    /[^.!?\n]*(?:has been (?:warned|muted|banned|kicked|timed out)|have been (?:warned|muted)|was (?:warned|muted|banned|kicked)|got (?:warned|muted|banned|kicked)|received a (?:formal )?warning|shown the door|violating server rules|disciplinary action)[^.!?\n]*[.!?]*/gi,
                    '',
                )
                .replace(
                    /[^.!?\n]*<@!?\d+>[^.!?\n]*(?:warn(?:ed|ing)?|mut(?:ed|ing)?|ban(?:ned|ning)?|kick(?:ed|ing)?|timeout|gag(?:ged|ging)?|silenc(?:ed|ing)?|booted)[^.!?\n]*[.!?]*/gi,
                    '',
                )
                .replace(
                    /[^.!?\n]*(?:warned|muted|banned|kicked|timed out|gagged|silenced|booted)\b[^.!?\n]*<@!?\d+>[^.!?\n]*[.!?]*/gi,
                    '',
                )
                // Completed-state claims without a mention ("tony is muted now").
                // Statements only: the lookahead requires a later ./!/end, so genuine
                // questions ("is tony muted?") survive.
                .replace(
                    /[^.!?\n]*\b(?:is|are|'re)\b[^.!?\n]*\b(?:muted|banned|kicked|warned|silenced|gagged)\b(?=[^.!?\n]*(?:[.!]|$))[^.!?\n]*/gi,
                    '',
                )
                // First-person past-tense claims ("I already muted Adi", "I've
                // banned tony") with plain names: no mention, no has-been, so
                // every pattern above misses them. Fiction when !modExecuted.
                // Colloquial "I warned you"-style prose can catch here too;
                // the footer below marks it as unverified rather than certain.
                .replace(
                    /[^.!?\n]*\bI(?:'ve| have)?\s+already\s+(?:warned|muted|banned|kicked|gagged|silenced|booted)\b[^.!?\n]*[.!?]*/gi,
                    '',
                )
                .replace(
                    /[^.!?\n]*\bI(?:'ve| have)?\s+(?:warned|muted|banned|kicked|gagged|silenced|booted)\b\s+(?:<@!?\d+>|[A-Z][\w.]{2,}|you|him|her|them)\b[^.!?\n]*[.!?]*/gi,
                    '',
                )
                .replace(/\n{3,}/g, '\n\n')
                .trim()
            // No footer on the confirm-setup path: the ⏳ note already signals
            // "not done yet", and a stale "nobody was warned" would linger after "yes".
            if (finalResponse !== before.trim() && !confirmNote) {
                finalResponse +=
                    '\n\n*-# ⚠️ quick flag: nothing was actually moderated just now — i only act on real mentions/commands. say the word with a mention if you want me to.*'
            }
        }

        // Format all executions cleanly
        if (executionLogs.length > 0) {
            finalResponse += `\n\n*-# ⚙️ ${executionLogs.join(' · ')}*`
        }
        // Honesty guard: if anything was blocked/ignored, say so visibly, otherwise
        // the model's own prose ("Reminder set!") ships as a false success claim.
        if (blockedNotes.length > 0) {
            this._blockedStreaks ??= new Map()
            const prev = this._blockedStreaks.get(message.author.id)
            const count =
                prev && Date.now() - prev.at < 300_000
                    ? prev.count + blockedNotes.length
                    : blockedNotes.length
            this._blockedStreaks.set(message.author.id, { count, at: Date.now() })
            const list = `\`${[...new Set(blockedNotes)].join('`, `')}\``
            finalResponse +=
                count >= 3
                    ? `\n\n*-# ⚠️ ${list} blocked again, that's ${count} strikes. i can tell what you're going for, and it's still no 💜*`
                    : `\n\n*-# ⚠️ ${list} didn't go through, try rephrasing.*`
        } else if (executionLogs.length > 0) {
            // A clean run resets the strike counter, it only tracks consecutive abuse.
            this._blockedStreaks?.delete(message.author.id)
        }
        // Self-audit follow-through: the model planned for more actions than it
        // actually attempted (no RUN_CMD tag at all for the missing one/s), so
        // there's nothing in executionLogs/blockedNotes to catch it. Surface the
        // gap explicitly instead of ending the reply looking fully complete.
        if (actionsIntended !== null && actionsIntended > matches.length) {
            finalResponse += `\n\n*-# 📋 Heads up, I planned ${actionsIntended} action${actionsIntended === 1 ? '' : 's'} but only attempted ${matches.length}. Something may have gotten dropped, let me know what's missing and I'll redo it.*`
        }
        let cleanedText = finalResponse
            .replace(/<{2,3}\s*RUN_CMD:\s*[\s\S]*?>{2,3}[>\s]*/g, '')
            .replace(/<{2,3}\s*ACTIONS_INTENDED:\s*\d+\s*>{2,3}/gi, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim()
        if (confirmNote) cleanedText = `${cleanedText}${cleanedText ? '\n\n' : ''}${confirmNote}`
        return {
            text: cleanedText,
            embeds: capturedEmbeds,
            confirmPending: confirmNote !== null,
            sensitive,
            confirmUI,
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
