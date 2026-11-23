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
import { matchMember, stripFakeModerationClaims } from './hot-kernels.js'
import { parseWhen } from '../reminders.js'

// Module-scope command metadata: shared by _executeParsedCommands (gates +
// confirm flow) and _runConfirmedCommand (perm re-check at execution time), so
// the two can never disagree about what a command needs.
export const MOD_CMDS = new Set([
    'ban',
    'unban',
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
    lockchannel: PermissionFlagsBits.ManageChannels,
    unlockchannel: PermissionFlagsBits.ManageChannels,
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

const REMINDER_CMDS = new Set(['remind', 'reminders', 'delreminder'])
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
    // then learned alias, then bounded fuzzy, then a live API search for big rosters).
    async _resolveMemberId(message, raw) {
        const clean = String(raw ?? '')
            .replace(/[<@!>]/g, '')
            .trim()
        if (/^\d{15,20}$/.test(clean)) return clean
        const guild = message?.guild
        if (!guild) return null
        if (/^(him|her|them|they|this (guy|user|person)|that (guy|user|person)|the user)$/i.test(clean)) {
            const refId = message.reference?.messageId
            const refMsg =
                (refId ? message.channel?.messages?.cache?.get(refId) : null) ??
                message._medusaReplyCtx?.ref ??
                (refId ? await message.fetchReference?.().catch(() => null) : null)
            const refAuthor = refMsg?.author ?? null
            if (refAuthor && !refAuthor.bot && refAuthor.id !== this.client?.user?.id) return refAuthor.id
            return null
        }
        if (clean.length < 2) return null
        const lower = clean.toLowerCase()

        // Project Discord GuildMembers to plain { id, names } records for the pure kernel
        const cacheMembers = [...(guild.members.cache?.values() ?? [])].map((m) => ({
            id: m.id,
            names: [m.user?.username, m.user?.globalName, m.displayName, m.nickname].filter(Boolean),
        }))
        const cacheHit = matchMember(clean, cacheMembers)
        if (cacheHit) return cacheHit

        // Learned aliases ("call me X") live in memory, not on the roster.
        try {
            const aliasHit = this.client?.aiCog?.getMem?.(guild)?.getUserIdByAlias?.(lower)
            if (aliasHit) return aliasHit
        } catch {}

        // Cache miss on a big roster (offline members aren't cached): ask the API.
        try {
            const found = await guild.members.fetch({ query: clean.slice(0, 100), limit: 5 })
            const apiMembers = [...found.values()].map((m) => ({
                id: m.id,
                names: [m.user?.username, m.user?.globalName, m.displayName, m.nickname].filter(Boolean),
            }))
            const apiHit = matchMember(clean, apiMembers)
            if (apiHit) return apiHit
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
    // explicit "nothing was executed" record in short-term history.
    _recordConfirmOutcome(key, message, outcome) {
        try {
            const [, cmdName, target] = String(key).split(':')
            const who = /^\d{15,20}$/.test(target ?? '') ? `<@${target}>` : target || 'that action'
            const hk = `${message.author.id}-${message.channel.id}`
            this.messageHistory ??= new Map()
            // Funnel through _histPush with isMemOff so both host-wide and per-user opt-out apply.
            this._histPush(hk, this.isMemOff(message.author.id), {
                role: 'assistant',
                content: `(${cmdName} ${who} was ${outcome} — nothing was executed.)`,
            })
        } catch {}
    }
    // Collector wiring for an already-posted confirm UI message.
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
                    await sent.edit({ components: [] }).catch(() => {})
                    this._sweepConfirm(confirmKey, 0)
                } catch {}
            })
        } catch (e) {
            console.error('[AI] Confirm UI watch failed:', e)
        }
    }
    // Expiry with refresh-awareness
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
        const CMD_PATTERN = /<{2,3}\s*RUN_CMD:\s*([a-zA-Z][a-zA-Z0-9_]*)\s*([\s\S]*?)>{2,3}/g
        const MAX_BATCH = 8
        const matches = [...response.matchAll(CMD_PATTERN)].slice(0, MAX_BATCH)
        // Repeat-offender gate
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
        const actionsIntendedMatch = response.match(/<{2,3}\s*ACTIONS_INTENDED:\s*(\d+)\s*>{2,3}/i)
        const actionsIntended = actionsIntendedMatch ? Number(actionsIntendedMatch[1]) : null
        const capturedEmbeds = []
        const executionLogs = []
        const blockedNotes = []
        const errorNotes = []
        const confirmNotes = []
        let modExecuted = false
        let confirmUI = null
        let sensitive = false

        const isOwnerUser = message.author.id === this.ownerId
        const userHasPerm = (perm, chan = null) =>
            isOwnerUser ||
            Boolean(chan ? message.member?.permissionsIn(chan)?.has(perm) : message.member?.permissions?.has(perm))
        const botHasPerm = (perm, chan = null) =>
            Boolean(
                chan
                    ? message.guild?.members.me?.permissionsIn(chan)?.has(perm)
                    : message.guild?.members.me?.permissions?.has(perm),
            )

        const dummyMsg = {
            edit: async () => dummyMsg,
            delete: async () => {},
            react: async () => {},
            channel: message.channel,
            id: message.id,
        }

        const captureOpts = (opts) => {
            const data = typeof opts === 'string' ? { content: opts } : opts
            if (data?.embeds) capturedEmbeds.push(...data.embeds)
            if (data?.content) executionLogs.push(data.content.replace(/\n/g, ' ').trim())
        }

        // Isolated per-execution wrapper instead of monkey-patching shared
        // message.channel.send across awaits (which breaks concurrent handlers).
        const wrappedChannel = message.channel
            ? new Proxy(message.channel, {
                  get(target, prop, receiver) {
                      if (prop === 'send') {
                          return async (opts) => {
                              captureOpts(opts)
                              return dummyMsg
                          }
                      }
                      const val = Reflect.get(target, prop, receiver)
                      return typeof val === 'function' ? val.bind(target) : val
                  },
              })
            : message.channel

        const execMessage = new Proxy(message, {
            get(target, prop, receiver) {
                if (prop === 'reply') {
                    return async (opts) => {
                        captureOpts(opts)
                        return dummyMsg
                    }
                }
                if (prop === 'channel') return wrappedChannel
                const val = Reflect.get(target, prop, receiver)
                return typeof val === 'function' ? val.bind(target) : val
            },
        })

        for (const match of matches) {
            let cmdName = match[1].toLowerCase()
            if (!REMINDER_CMDS.has(cmdName) && /remind/i.test(cmdName)) {
                if (/list|show|view|check|pending|all/i.test(cmdName)) cmdName = 'reminders'
                else if (/del|cancel|remove|stop|clear/i.test(cmdName)) cmdName = 'delreminder'
                else cmdName = 'remind'
            }
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
                const hasPerm = isOwnerUser || (requiredPerm && message.member?.permissions?.has(requiredPerm))
                const botPerm = !requiredPerm || message.guild?.members.me?.permissions?.has(requiredPerm)

                if (!hasPerm) {
                    console.warn(`[AI] Blocked unpermitted RUN_CMD '${cmdName}' by ${message.author.id}`)
                    errorNotes.push(`🔑 You don't have permission to \`${cmdName}\`.`)
                    continue
                }
                if (!botPerm) {
                    console.warn(
                        `[AI] Blocked RUN_CMD '${cmdName}': Bot lacks permission ${requiredPerm}`,
                    )
                    errorNotes.push(`🛑 I don't have permission to \`${cmdName}\` here.`)
                    continue
                }
            }

            if (!this.client.commands?.has(cmdName) && !VIRTUAL_CMDS.has(cmdName)) {
                console.warn(`[AI] Ignored unknown RUN_CMD '${cmdName}'`)
                blockedNotes.push(cmdName)
                continue
            }

            let argsStr = match[2].trim()
            argsStr = argsStr
                .replace(/[\u201C\u201D\u201E]/g, '"')
                .replace(/[\u2018\u2019]/g, "'")
                .replace(/[\u2013\u2014]/g, '-')
            if (cmdName === 'remind') {
                const rescued = extractReminderArgs(argsStr)
                if (rescued) argsStr = rescued
            }
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
            const MODE = FREE_TEXT_CMDS.has(cmdName) ? 'free' : 'strict'
            if (MODE === 'strict') {
                if (!/^[\w\s.,:'"@#<>!&\-]*$/u.test(argsStr)) {
                    console.warn(
                        `[AI] Blocked RUN_CMD '${cmdName}', strict arg check failed: ${argsStr.slice(0, 120)}`,
                    )
                    blockedNotes.push(cmdName)
                    continue
                }
            } else {
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
            if (DESTRUCTIVE_CMDS.has(cmdName)) {
                const needsUserId = USER_TARGET_CMDS.has(cmdName)
                const needsInt = INT_COUNT_CMDS.has(cmdName)
                let rawArg = args[0]?.replace(/[<@!>]/g, '') ?? ''
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
                    errorNotes.push(
                        `❌ I couldn't find them — give me a @mention, exact username, or reply to their message, then I'll \`${cmdName}\`.`,
                    )
                    continue
                }
                if (needsInt && !/^\d{1,3}$/.test(rawArg)) {
                    console.warn(
                        `[AI] Blocked hallucinated ${cmdName}, arg '${rawArg}' is not a valid count`,
                    )
                    errorNotes.push(`❌ I couldn't \`${cmdName}\`, that wasn't a valid number of messages.`)
                    continue
                }
                const targetArg = (rawArg.toLowerCase() || 'none').slice(0, 60)
                const confirmKey = `${message.author.id}:${cmdName}:${targetArg}`
                const approved = this._approvedConfirms?.delete(confirmKey) === true
                const existing = this._pendingConfirms.get(confirmKey)
                const now = Date.now()
                const target =
                    cmdName === 'announce'
                        ? (args[0] ?? '').replace(/^<#(\d{15,20})>$/, '<#$1>')
                        : args[0] && /^\d{15,20}$/.test(args[0])
                          ? `<@${args[0]}>`
                          : (args[0] ?? '')
                const reason = args.slice(1).join(' ')
                const closers = [
                    "say **yes** (or tap ✅) within 30s and it's done.",
                    "yes or no — or tap ✅ / ❌. you've got 30s before i lose interest.",
                    '**yes** (or ✅) in the next 30s, or it never happened.',
                ]
                const noteBase = `you want me to \`${cmdName}\`${target ? ` on ${target}` : ''}${reason ? ` — "${reason}"` : ''}?`
                const closer = closers[confirmKey.length % closers.length]
                const uiParts = () => ({
                    key: confirmKey,
                    row: this.buildConfirmRow(cmdName, targetArg),
                    embed: this.buildConfirmEmbed(cmdName, targetArg, reason, message.author.id),
                })
                if (approved) {
                    this._pendingConfirms.delete(confirmKey)
                } else {
                    if (existing && now - existing.ts <= 30_000) {
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
                            if (!existing.uiMsg && !confirmUI) confirmUI = uiParts()
                            confirmNotes.push(`🔄 updated — ${noteBase} ${closer}`)
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
                        if (cmdName === 'mute') {
                            const rawId = args[0]?.replace(/[<@!>]/g, '')
                            const targetMember = rawId ? message.guild?.members.cache.get(rawId) : null
                            if (targetMember && !targetMember.moderatable) {
                                errorNotes.push(
                                    `❌ I can't mute <@${rawId}>, they're above me in the hierarchy.`,
                                )
                                continue
                            }
                        }
                        this._pendingConfirms.set(confirmKey, { ts: now, args: argsStr, noteTs: now })
                        this._sweepConfirm(confirmKey)
                        confirmNotes.push(`⏳ ${noteBase} ${closer}`)
                        if (!confirmUI) confirmUI = uiParts()
                        console.log(
                            `[AI] Confirmation requested for '${cmdName}' by ${message.author.id}`,
                        )
                        continue
                    }
                    this._pendingConfirms.delete(confirmKey)
                }
            }

            const handler = this.client.commands?.get(cmdName)

            if (handler) {
                try {
                    await handler(execMessage, args)
                    if (MOD_CMDS.has(cmdName)) modExecuted = true
                    console.log(`[AI] Executed '${cmdName}' args='${argsStr}' by ${message.author.id}`)
                } catch (e) {
                    this.errorCount++
                    console.error('[AI] Auto-exec error:', e)
                }
            } else {
                try {
                    if (cmdName === 'poll') {
                        const pollPerm = PermissionFlagsBits.SendPolls ?? PermissionFlagsBits.SendMessages
                        if (!userHasPerm(pollPerm, message.channel)) {
                            errorNotes.push('🔑 You need Send Polls permission to create a poll.')
                            continue
                        }
                        if (!botHasPerm(pollPerm, message.channel)) {
                            errorNotes.push("🛑 I don't have permission to send polls here.")
                            continue
                        }
                        const parts = [...argsStr.matchAll(/"([^"]+)"/g)].map((m) => m[1])
                        if (parts.length >= 2) {
                            const [question, ...answers] = parts
                            await message.channel.send({
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
                        if (!userHasPerm(PermissionFlagsBits.CreatePublicThreads, message.channel)) {
                            errorNotes.push('🔑 You need Create Public Threads permission to start a thread.')
                            continue
                        }
                        if (!botHasPerm(PermissionFlagsBits.CreatePublicThreads, message.channel)) {
                            errorNotes.push("🛑 I don't have permission to create threads here.")
                            continue
                        }
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
                        if (!userHasPerm(PermissionFlagsBits.ManageMessages, message.channel)) {
                            errorNotes.push('🔑 You need Manage Messages to pin.')
                            continue
                        }
                        if (!botHasPerm(PermissionFlagsBits.ManageMessages, message.channel)) {
                            errorNotes.push("🛑 I don't have permission to pin messages here.")
                            continue
                        }
                        const targetId = args[0]
                        if (targetId && /^\d{15,20}$/.test(targetId)) {
                            const m2 = await message.channel.messages.fetch(targetId).catch(() => null)
                            if (m2) {
                                await m2.pin().catch(() => {})
                                executionLogs.push(`📌 Pinned`)
                            }
                        }
                    } else if (cmdName === 'unpin') {
                        if (!userHasPerm(PermissionFlagsBits.ManageMessages, message.channel)) {
                            errorNotes.push('🔑 You need Manage Messages to unpin.')
                            continue
                        }
                        if (!botHasPerm(PermissionFlagsBits.ManageMessages, message.channel)) {
                            errorNotes.push("🛑 I don't have permission to unpin messages here.")
                            continue
                        }
                        const targetId = args[0]
                        if (targetId && /^\d{15,20}$/.test(targetId)) {
                            const m2 = await message.channel.messages.fetch(targetId).catch(() => null)
                            if (m2) {
                                await m2.unpin().catch(() => {})
                                executionLogs.push(`📌 Unpinned`)
                            }
                        }
                    } else if (cmdName === 'slowmode') {
                        if (!userHasPerm(PermissionFlagsBits.ManageChannels, message.channel)) {
                            errorNotes.push('🔑 You need Manage Channels to set slowmode.')
                            continue
                        }
                        if (!botHasPerm(PermissionFlagsBits.ManageChannels, message.channel)) {
                            errorNotes.push("🛑 I don't have permission to set slowmode here.")
                            continue
                        }
                        const secs = Math.min(Math.max(0, parseInt(args[0], 10) || 0), 21600)
                        if (message.channel.isTextBased()) {
                            await message.channel.setRateLimitPerUser(secs)
                            executionLogs.push(`🐢 Slowmode: ${secs}s`)
                        }
                    } else if (cmdName === 'topic') {
                        if (!userHasPerm(PermissionFlagsBits.ManageChannels, message.channel)) {
                            errorNotes.push('🔑 You need Manage Channels to change the topic.')
                            continue
                        }
                        if (!botHasPerm(PermissionFlagsBits.ManageChannels, message.channel)) {
                            errorNotes.push("🛑 I don't have permission to change the channel topic here.")
                            continue
                        }
                        if (argsStr && message.channel.isTextBased()) {
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
                        if (!body) errorNotes.push('❌ Give me a channel and announcement text.')
                        else if (!chan)
                            errorNotes.push(`❌ I couldn't find channel ${rawTarget || '(missing)'}.`)
                        else if (!chan.isTextBased() || !chan.isSendable())
                            errorNotes.push(`❌ #${chan.name} can't accept messages.`)
                        else if (
                            !userHasPerm(PermissionFlagsBits.ManageMessages, chan) ||
                            !userHasPerm(PermissionFlagsBits.SendMessages, chan)
                        )
                            errorNotes.push(
                                `🔑 You need Manage Messages and Send Messages in #${chan.name} to announce.`,
                            )
                        else if (!botHasPerm(PermissionFlagsBits.SendMessages, chan))
                            errorNotes.push(`🛑 I don't have permission to send messages in #${chan.name}.`)
                        else {
                            const safeBody = this.finalSecurityCheck(body, message)
                            if (!safeBody.trim()) {
                                errorNotes.push('❌ Announcement blocked by safety check.')
                                continue
                            }
                            const userIds = [...safeBody.matchAll(/<@!?(\d{15,20})>/g)].map((m) => m[1])
                            await chan.send({
                                content: safeBody,
                                allowedMentions: { users: [...new Set(userIds)], parse: [] },
                            })
                            executionLogs.push(`📢 Announced to #${chan.name}`)
                        }
                    } else if (cmdName === 'mail') {
                        if (!argsStr) errorNotes.push('❌ Tell me what to send Tav.')
                        else if (typeof this.client.sendDeveloperMail !== 'function')
                            errorNotes.push('❌ Mail is unavailable right now.')
                        else {
                            const result = await this.client.sendDeveloperMail(message, argsStr)
                            if (result.ok) executionLogs.push(`📬 Mail sent to Tav`)
                            else errorNotes.push(`❌ Mail failed: ${result.error}`)
                        }
                    } else if (cmdName === 'movevc') {
                        const [uid, cid] = args
                        if (!userHasPerm(PermissionFlagsBits.MoveMembers)) {
                            errorNotes.push('🔑 You need Move Members permission.')
                            continue
                        }
                        if (!botHasPerm(PermissionFlagsBits.MoveMembers)) {
                            errorNotes.push("🛑 I don't have permission to move voice members.")
                            continue
                        }
                        if (uid && cid) {
                            const target = await message.guild?.members.fetch(uid).catch(() => null)
                            const chan = message.guild?.channels.cache.get(cid)
                            if (target?.voice?.channel && chan) {
                                await target.voice.setChannel(chan)
                                executionLogs.push(`🔊 Moved to ${chan.name}`)
                            }
                        }
                    } else if (cmdName === 'dm') {
                        if (isOwnerUser) {
                            const uid = args[0]
                            const body = args.slice(1).join(' ')
                            if (uid && body) {
                                const user = await this.client.users.fetch(uid).catch(() => null)
                                if (user) {
                                    await user.send(body).catch(() => {})
                                    executionLogs.push(`📨 DM sent`)
                                }
                            }
                        } else {
                            errorNotes.push('🔑 Only the bot owner can use `dm`.')
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

        const confirmNote = confirmNotes.length ? confirmNotes.join('\n') : null

        // Honesty guard for prose enforcement claims ("User @X has been warned…"):
        // uses linear-time sentence stripping from hot-kernels.js (zero ReDoS).
        if (!modExecuted) {
            const before = finalResponse
            finalResponse = stripFakeModerationClaims(finalResponse)
            if (finalResponse !== before.trim() && !confirmNote) {
                finalResponse +=
                    '\n\n*-# ⚠️ quick flag: nothing was actually moderated just now — i only act on real mentions/commands. say the word with a mention if you want me to.*'
            }
        }

        // Format all executions cleanly
        if (executionLogs.length > 0) {
            finalResponse += `\n\n*-# ⚙️ ${executionLogs.join(' · ')}*`
        }
        if (errorNotes.length > 0) {
            finalResponse =
                matches.length === 1 && !executionLogs.length && !confirmNote
                    ? errorNotes[0]
                    : `${finalResponse}${finalResponse ? '\n\n' : ''}${errorNotes.join('\n')}`
        }
        // Honesty guard: if anything was blocked/ignored, say so visibly
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
            this._blockedStreaks?.delete(message.author.id)
        }
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

        if (!hasOwnership || !hasIntent) return null

        if (BANNER_WORDS.test(bareMsg)) {
            const isServer = /\b(server|guild|local)\b/i.test(bareMsg)
            return `here you go 💜 <<RUN_CMD: ${isServer ? 'bn' : 'mbn'} ${targetId}>>`
        }
        if (AVATAR_WORDS.test(bareMsg)) return `here you go ✨ <<RUN_CMD: av ${targetId}>>`
        return null
    }
}
