import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType,
    EmbedBuilder,
    MessageFlags,
    PermissionFlagsBits,
} from 'discord.js'
import { formatDuration, parseTime, resolveTarget } from './utils.js'

export { formatDuration, parseTime }

const stmtCache = new WeakMap()
function getStmts(db) {
    let s = stmtCache.get(db)
    if (!s) {
        s = {
            insertLog: db.prepare(
                'INSERT INTO mod_logs (guild_id, user_id, moderator_id, action, reason, duration) VALUES (?,?,?,?,?,?)',
            ),
            insertWarn: db.prepare(
                'INSERT INTO warnings (guild_id, user_id, moderator_id, reason) VALUES (?,?,?,?)',
            ),
            activeWarns: db.prepare(
                'SELECT id, moderator_id, reason, timestamp FROM warnings WHERE guild_id=? AND user_id=? AND active=TRUE ORDER BY timestamp DESC',
            ),
            modLogsByUser: db.prepare(
                'SELECT user_id, moderator_id, action, reason, duration, timestamp FROM mod_logs WHERE guild_id=? AND (user_id=? OR moderator_id=?) ORDER BY timestamp DESC',
            ),
            modLogsAll: db.prepare(
                'SELECT user_id, moderator_id, action, reason, duration, timestamp FROM mod_logs WHERE guild_id=? ORDER BY timestamp DESC',
            ),
            warnsByUser: db.prepare(
                'SELECT user_id, moderator_id, reason, timestamp FROM warnings WHERE guild_id=? AND (user_id=? OR moderator_id=?) AND active=TRUE ORDER BY timestamp DESC',
            ),
            warnsAll: db.prepare(
                'SELECT user_id, moderator_id, reason, timestamp FROM warnings WHERE guild_id=? AND active=TRUE ORDER BY timestamp DESC',
            ),
            clearWarns: db.prepare('UPDATE warnings SET active=FALSE WHERE guild_id=? AND user_id=?'),
        }
        stmtCache.set(db, s)
    }
    return s
}

export function logAction(db, guildId, userId, modId, action, reason, duration = null) {
    try {
        getStmts(db).insertLog.run(
            String(guildId),
            String(userId),
            String(modId),
            action,
            reason,
            duration ?? 'N/A',
        )
    } catch (e) {
        console.error('[logAction]', e)
    }
}

export function canModerate(author, target, guild) {
    const authorId = String(author.id ?? author.user?.id)
    const targetId = String(target.id ?? target.user?.id)
    if (guild.ownerId === targetId) return false
    if (guild.ownerId === authorId) return true
    // Administrator permission bypasses role hierarchy (except server owner, handled above)
    if (author.permissions?.has(PermissionFlagsBits.Administrator)) return true
    const authorPos = author.roles?.highest?.position ?? 0
    const targetPos = target.roles?.highest?.position ?? 0
    return authorPos > targetPos
}

export async function sendDMNotif(member, action, guild, reason, duration = null) {
    try {
        const embed = new EmbedBuilder()
            .setTitle('Mod Action Notification')
            .setDescription(
                `👁️ | You've been ${action.toLowerCase()} in **${guild.name}**${duration ? ` for **${duration}**` : ''}.\nReason: \`${reason}\``,
            )
            .setColor(0x378add)
            .setTimestamp()
        if (guild.iconURL()) embed.setFooter({ text: guild.name, iconURL: guild.iconURL() })
        await member.send({ embeds: [embed] })
    } catch {}
}

export function modEmbed(action, member, reason, guild, duration = null) {
    const desc = `👤 **Member:** ${member} (\`${member.id}\`)\n📌 **Reason:** ${reason}`
    const embed = new EmbedBuilder()
        .setTitle(action)
        .setDescription(duration ? `${desc}\n⏳ **Duration:** ${duration}` : desc)
        .setColor(0x378add)
    if (guild.iconURL()) embed.setFooter({ text: guild.name, iconURL: guild.iconURL() })
    return embed
}

export async function retryOnce(fn) {
    try {
        return await fn()
    } catch (e) {
        await new Promise((r) => setTimeout(r, 1500))
        return fn()
    }
}

export async function cmdBan(ctx, member, reason, { db, BOT_OWNER_ID }) {
    const guild = ctx.guild
    const author = ctx.member ?? ctx.user
    if (BigInt(member.id) === BOT_OWNER_ID)
        return ctx.reply({ content: '🚫 | You cannot ban the bot owner.' })
    if (!canModerate(author, member, guild))
        return ctx.reply({ content: '🚫 You cannot ban someone with an equal or higher role.' })
    if (member.bannable === false)
        return ctx.reply({ content: `🚫 I don't have enough permission hierarchy to ban ${member}!` })
    try {
        await guild.bans.fetch(member.id)
        return ctx.reply({ content: `🚫 ${member} is already banned.` })
    } catch {}
    try {
        await sendDMNotif(member.user ?? member, 'Ban', guild, reason).catch(() => null)
        await guild.members.ban(member, { reason })
        logAction(db, guild.id, member.id, author.id, 'Ban', reason)
        await ctx.reply({ embeds: [modEmbed('Ban', member.user ?? member, reason, guild, null)] })
    } catch (e) {
        await ctx.reply({ content: `❌ Error trying to ban: ${e.message}` })
    }
}

export async function cmdKick(ctx, member, reason, { db, BOT_OWNER_ID }) {
    const guild = ctx.guild
    const author = ctx.member ?? ctx.user
    if (BigInt(member.id) === BOT_OWNER_ID)
        return ctx.reply({ content: '🚫 | You cannot kick the bot owner.' })
    if (!canModerate(author, member, guild))
        return ctx.reply({ content: '🚫 You cannot kick someone with an equal or higher role.' })
    if (member.kickable === false)
        return ctx.reply({ content: `🚫 I don't have enough permission hierarchy to kick ${member}!` })
    try {
        await sendDMNotif(member.user ?? member, 'Kick', guild, reason).catch(() => null)
        await member.kick(reason)
        logAction(db, guild.id, member.id, author.id, 'Kick', reason)
        await ctx.reply({ embeds: [modEmbed('Kick', member.user ?? member, reason, guild, null)] })
    } catch (e) {
        await ctx.reply({ content: `❌ Error trying to kick: ${e.message}` })
    }
}

export async function cmdUnban(ctx, userId, { db }) {
    const guild = ctx.guild
    const author = ctx.member ?? ctx.user
    try {
        const ban = await guild.bans.fetch(userId)
        await guild.members.unban(userId, 'Unbanned')
        logAction(db, guild.id, userId, author.id, 'Unban', 'Unbanned')
        await ctx.reply({ embeds: [modEmbed('Unban', ban.user, 'Unbanned', guild)] })
    } catch {
        await ctx.reply({ content: '🚫 User not found in ban list.' })
    }
}

export async function cmdMute(ctx, member, durationStr, reason, { db, BOT_OWNER_ID }) {
    const guild = ctx.guild
    const author = ctx.member ?? ctx.user
    if (BigInt(member.id) === BOT_OWNER_ID)
        return ctx.reply({ content: '🚫 | You cannot mute the bot owner.' })
    if (!canModerate(author, member, guild))
        return ctx.reply({ content: '🚫 You cannot mute someone with an equal or higher role.' })
    if (member.moderatable === false)
        return ctx.reply({ content: `🚫 I don't have enough permission hierarchy to mute ${member}!` })
    if (member.communicationDisabledUntilTimestamp > Date.now())
        return ctx.reply({ content: `🚫 ${member} is already muted.` })
    const { delta, error } = parseTime(durationStr)
    if (error) return ctx.reply({ content: error })
    try {
        await member.timeout(delta, reason)
        await sendDMNotif(member.user, 'Mute', guild, reason, durationStr).catch(() => null)
        logAction(db, guild.id, member.id, author.id, 'Mute', reason, durationStr)
        await ctx.reply({ embeds: [modEmbed('Mute', member.user, reason, guild, durationStr)] })
    } catch (e) {
        await ctx.reply({ content: `❌ Error trying to mute: ${e.message}` })
    }
}

export async function cmdUnmute(ctx, member, { db }) {
    const guild = ctx.guild
    const author = ctx.member ?? ctx.user
    if (!canModerate(author, member, guild))
        return ctx.reply({ content: '🚫 You cannot unmute someone with an equal or higher role.' })
    if (member.moderatable === false)
        return ctx.reply({ content: `🚫 I don't have enough permission hierarchy to unmute ${member}!` })
    if (
        !member.communicationDisabledUntilTimestamp ||
        member.communicationDisabledUntilTimestamp <= Date.now()
    )
        return ctx.reply({ content: `🚫 ${member} is not muted.` })
    try {
        await member.timeout(null)
        await sendDMNotif(member.user, 'Unmute', guild, 'Unmuted').catch(() => null)
        logAction(db, guild.id, member.id, author.id, 'Unmute', 'Unmuted')
        await ctx.reply({ embeds: [modEmbed('Unmute', member.user, 'Unmuted', guild, null)] })
    } catch (e) {
        await ctx.reply({ content: `❌ Error trying to unmute: ${e.message}` })
    }
}

export async function cmdWarn(ctx, member, reason, { db, BOT_OWNER_ID }) {
    const guild = ctx.guild
    const author = ctx.member ?? ctx.user
    if (BigInt(member.id) === BOT_OWNER_ID)
        return ctx.reply({ content: '🚫 | You cannot warn the bot owner.' })
    if (!canModerate(author, member, guild) && BigInt(author.id) !== BOT_OWNER_ID)
        return ctx.reply({ content: '🚫 You cannot warn someone with an equal or higher role.' })
    const result = getStmts(db).insertWarn.run(String(guild.id), String(member.id), String(author.id), reason)
    await sendDMNotif(member.user, 'Warned', guild, reason)
    await ctx.reply({
        embeds: [
            new EmbedBuilder()
                .setTitle('⚠️ User Warned')
                .setDescription(
                    `👤 **Member:** ${member} (\`${member.id}\`)\n📌 **Reason:** ${reason}\n🆔 **Warning ID:** #${result.lastInsertRowid}`,
                )
                .setColor(0xef9f27)
                .setFooter({ text: guild.name, iconURL: guild.iconURL() ?? undefined }),
        ],
    })
}

export async function cmdWarnings(ctx, member, { db }) {
    // Slash lookups go ephemeral (only the invoker sees them); prefix replies
    // can't be ephemeral, so they stay public.
    const isSlash = Boolean(ctx.isChatInputCommand?.())
    const eph = isSlash ? { flags: MessageFlags.Ephemeral } : {}
    const rows = getStmts(db).activeWarns.all(String(ctx.guild.id), String(member.id))
    if (!rows.length) return ctx.reply({ content: `${member} has no active warnings.`, ...eph })
    const PER = 10
    const pages = Math.max(1, Math.ceil(rows.length / PER))
    let cur = 0
    const mkEmbed = (p) => {
        const embed = new EmbedBuilder()
            .setTitle(`⚠️ Warnings for ${member.displayName}`)
            .setColor(0xef9f27)
            .setFooter({
                text: pages > 1 ? `Page ${p + 1}/${pages} • Total: ${rows.length}` : `Total: ${rows.length}`,
            })
        for (const { id, moderator_id, reason, timestamp } of rows.slice(p * PER, (p + 1) * PER)) {
            const mod = ctx.guild.members.cache.get(String(moderator_id))
            embed.addFields({
                name: `Warning #${id}`,
                value: `**Moderator:** ${mod ?? `<@${moderator_id}>`}\n**Reason:** ${reason}\n**Date:** ${timestamp.slice(0, 10)}`,
                inline: false,
            })
        }
        return embed
    }
    const mkRow = (p) =>
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('w_prev')
                .setEmoji('⬅️')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(p === 0),
            new ButtonBuilder()
                .setCustomId('w_next')
                .setEmoji('➡️')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(p >= pages - 1),
            new ButtonBuilder().setCustomId('w_del').setEmoji('❌').setStyle(ButtonStyle.Danger),
        )
    const replied = await ctx.reply({ embeds: [mkEmbed(0)], components: [mkRow(0)], ...eph })
    const send = isSlash ? await ctx.fetchReply().catch(() => null) : replied
    if (!send?.createMessageComponentCollector) return
    const col = send.createMessageComponentCollector({ componentType: ComponentType.Button, time: 60_000 })
    col.on('collect', async (i) => {
        const auth = ctx.user ?? ctx.author
        if (i.user.id !== auth?.id)
            return i.reply({
                content: 'Only the command user can use these buttons.',
                flags: MessageFlags.Ephemeral,
            })
        if (i.customId === 'w_del') {
            col.stop()
            return i.update({ components: [] })
        }
        if (i.customId === 'w_prev') cur = Math.max(0, cur - 1)
        if (i.customId === 'w_next') cur = Math.min(pages - 1, cur + 1)
        await i.update({ embeds: [mkEmbed(cur)], components: [mkRow(cur)] })
    })
    col.on('end', () => send.edit({ components: [] }).catch(() => {}))
}

export async function cmdModlog(ctx, user, { db }) {
    const isSlash = Boolean(ctx.isChatInputCommand?.())
    const eph = isSlash ? { flags: MessageFlags.Ephemeral } : {}
    const gId = String(ctx.guild.id)
    const uid = user ? String(user.id) : null
    const stmts = getStmts(db)
    const modRows = uid ? stmts.modLogsByUser.all(gId, uid, uid) : stmts.modLogsAll.all(gId)
    const warnRows = uid ? stmts.warnsByUser.all(gId, uid, uid) : stmts.warnsAll.all(gId)
    const logs = [
        ...modRows.map((r) => {
            const dur = r.duration && r.duration !== 'N/A' ? ` | **Duration:** ${r.duration}` : ''
            return `**${r.action}** - <@${r.user_id}> | **Reason:** ${r.reason} | **By:** <@${r.moderator_id}> | **Date:** ${r.timestamp.slice(0, 16)}${dur}`
        }),
        ...warnRows.map(
            (r) =>
                `**Warn** - <@${r.user_id}> | **Reason:** ${r.reason} | **By:** <@${r.moderator_id}> | **Date:** ${r.timestamp.slice(0, 16)}`,
        ),
    ]
    if (!logs.length)
        return ctx.reply({
            content: user ? `No moderation logs found for ${user}.` : 'No moderation logs found.',
            ...eph,
        })
    const PER = 20
    const MAX_DESC = 4096
    const pageChunks = []
    let current = []
    let currentLen = 0
    for (const line of logs) {
        const safeLine = line.length > MAX_DESC ? `${line.slice(0, MAX_DESC - 3)}...` : line
        const addedLen = (current.length ? 1 : 0) + safeLine.length
        if (current.length >= PER || (current.length > 0 && currentLen + addedLen > MAX_DESC)) {
            pageChunks.push(current.join('\n'))
            current = [safeLine]
            currentLen = safeLine.length
        } else {
            current.push(safeLine)
            currentLen += addedLen
        }
    }
    if (current.length) pageChunks.push(current.join('\n'))
    const pages = pageChunks.length
    let cur = 0
    const mkEmbed = (p) =>
        new EmbedBuilder()
            .setTitle(user ? `📜 Moderation Logs - ${user.username}` : '📜 Moderation Logs')
            .setDescription(pageChunks[p].slice(0, MAX_DESC))
            .setColor(0x378add)
            .setFooter({
                text: pages > 1 ? `Page ${p + 1}/${pages} • Total: ${logs.length}` : `Total: ${logs.length}`,
            })
    const mkRow = (p) =>
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('ml_prev')
                .setEmoji('⬅️')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(p === 0),
            new ButtonBuilder()
                .setCustomId('ml_next')
                .setEmoji('➡️')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(p >= pages - 1),
            new ButtonBuilder().setCustomId('ml_del').setEmoji('❌').setStyle(ButtonStyle.Danger),
        )
    const replied = await ctx.reply({
        embeds: [mkEmbed(0)],
        components: [mkRow(0)],
        ...eph,
    })
    const send = isSlash ? await ctx.fetchReply().catch(() => null) : replied
    if (!send?.createMessageComponentCollector) return
    const col = send.createMessageComponentCollector({ componentType: ComponentType.Button, time: 60_000 })
    col.on('collect', async (i) => {
        const auth = ctx.user ?? ctx.author
        if (i.user.id !== auth?.id)
            return i.reply({
                content: 'Only the command user can use these buttons.',
                flags: MessageFlags.Ephemeral,
            })
        if (i.customId === 'ml_del') {
            col.stop()
            return i.update({ components: [] })
        }
        if (i.customId === 'ml_prev') cur = Math.max(0, cur - 1)
        if (i.customId === 'ml_next') cur = Math.min(pages - 1, cur + 1)
        await i.update({ embeds: [mkEmbed(cur)], components: [mkRow(cur)] })
    })
    col.on('end', () => send.edit({ components: [] }).catch(() => {}))
}

export async function cmdClear(ctx, amount = 10) {
    const chan = ctx.channel
    const send = ctx.deferred ? (data) => ctx.editReply(data) : (data) => ctx.reply(data)
    let deleted
    try {
        const msgs = await chan.bulkDelete(amount, true)
        deleted = msgs.size
    } catch {
        return send({ content: '❌ Failed to delete messages.' })
    }
    const embed = new EmbedBuilder()
        .setTitle('Messages Cleared 🐍')
        .setDescription(`✅ **Deleted \`${deleted}\` messages by ${ctx.user ?? ctx.author}**`)
        .setColor(0x378add)
        .setTimestamp()
    if (ctx.guild?.iconURL()) embed.setFooter({ text: ctx.guild.name, iconURL: ctx.guild.iconURL() })
    await send({ embeds: [embed] })
}

// accepts a raw message ID or a full message link, returns the ID or null
function parseMessageRef(ref) {
    if (!ref) return null
    const m = String(ref)
        .trim()
        .match(/(\d{15,20})\s*$/)
    return m ? m[1] : null
}

export async function cmdFpurge(
    ctx,
    text,
    user = null,
    exact = false,
    limit = 100,
    startFrom = null,
    stopAt = null,
) {
    const send =
        ctx.deferred || ctx.replied
            ? (data) => ctx.editReply(data)
            : ctx.isChatInputCommand?.()
              ? (data) => ctx.reply(data)
              : (data) => ctx.reply(data).catch(() => ctx.channel.send(data))
    const startId = parseMessageRef(startFrom)
    const stopId = parseMessageRef(stopAt)
    if ((startFrom && !startId) || (stopAt && !stopId))
        return send({ content: '❌ That message ID or link does not look right.' })
    if (startId && stopId && BigInt(startId) <= BigInt(stopId))
        return send({ content: '❌ start-from has to be newer than stop-at.' })
    try {
        let found = 0
        let checked = 0
        let done = false
        // bump the cursor one snowflake up so the start message itself gets checked too
        let cursor = startId ? (BigInt(startId) + 1n).toString() : null
        const targetId = user?.id ?? null
        const searchText = (text ?? '').toLowerCase()
        while (checked < limit && !done) {
            const batch = Math.min(100, limit - checked)
            const fetchOpts = { limit: batch }
            if (cursor) fetchOpts.before = cursor
            const msgs = await ctx.channel.messages.fetch(fetchOpts)
            if (!msgs.size) break
            const toDelete = []
            for (const m of msgs.values()) {
                if (stopId && BigInt(m.id) < BigInt(stopId)) {
                    done = true
                    break
                }
                checked++
                cursor = m.id
                if (targetId && m.author.id !== targetId) continue
                const content = (m.content ?? '').toLowerCase()
                if (exact ? content === searchText : content.includes(searchText)) toDelete.push(m)
            }
            if (toDelete.length) {
                const deleted = await ctx.channel.bulkDelete(toDelete, true)
                found += deleted.size
            }
            if (msgs.size < batch) break
        }
        await send({
            content: `🧹 Deleted **${found}** matching message${found === 1 ? '' : 's'} (checked ${checked}).`,
        })
    } catch (e) {
        await send({ content: `❌ Failed: ${e.message}` })
    }
}

async function processChannel(client, channel, targetUser, cutoffTs, startFromId = null) {
    let deleted = 0,
        lastId = startFromId
    while (true) {
        const opts = { limit: 100 }
        if (lastId) opts.before = lastId
        const msgs = await channel.messages.fetch(opts).catch(() => null)
        if (!msgs?.size) break
        const toDelete = msgs.filter((m) => m.author.id === targetUser.id && m.createdTimestamp >= cutoffTs)
        if (toDelete.size) {
            const res = await channel.bulkDelete(toDelete, true).catch(() => null)
            deleted += res?.size ?? 0
        }
        const lastMsg = msgs.last()
        if (msgs.size < 100 || !lastMsg || lastMsg.createdTimestamp < cutoffTs) break
        lastId = lastMsg.id
        await new Promise((r) => setTimeout(r, 200))
    }
    return deleted
}

export async function cmdMpurge(ctx, targetUser, serverWide = false, startFromId = null) {
    const send =
        ctx.deferred || ctx.replied
            ? (data) => ctx.editReply(data)
            : ctx.isChatInputCommand?.()
              ? (data) => ctx.reply(data)
              : (data) => ctx.reply(data).catch(() => ctx.channel.send(data))
    const cutoffTs = Date.now() - 14 * 24 * 60 * 60 * 1000
    let total = 0
    try {
        if (serverWide) {
            const channels = ctx.guild.channels.cache.filter((c) => c.isTextBased())
            for (const ch of channels.values())
                total += await processChannel(ctx.client, ch, targetUser, cutoffTs)
        } else {
            total += await processChannel(ctx.client, ctx.channel, targetUser, cutoffTs, startFromId)
        }
        await send({
            content: `✅ Deleted **${total}** messages from **${targetUser.username}**${serverWide ? ' (server-wide)' : ''}.`,
        })
    } catch (e) {
        await send({ content: `❌ Failed: ${e.message}` })
    }
}

export function registerModeration(client, db, config) {
    const BOT_OWNER_ID = config.ownerId ? BigInt(config.ownerId) : 0n
    const ctx_ = { db, BOT_OWNER_ID }
    const isOwner = (id) => BigInt(id) === BOT_OWNER_ID
    try {
        if (db && db._stub !== true) getStmts(db)
    } catch {}

    // Custom keyword trigger phrases, configure in config.json to enable. (for funsies like the old days)
    // e.g. "mute_phrases": ["quiet", "shh"], "ban_phrases": ["get out"]
    const MUTE_CMDS = config.mutePhrases ?? []
    const BAN_CMDS = config.banPhrases ?? []
    const UNMUTE_CMDS = config.unmutePhrases ?? []

    client.commands.set('ban', async (msg, args) => {
        if (!msg.member?.permissions?.has(PermissionFlagsBits.BanMembers)) return
        const target = await resolveTarget(msg, args, false, false)
        if (!target) return msg.reply('Say who — mention them or give me an ID.')
        await cmdBan(msg, target, args.slice(1).join(' ') || 'No reason provided', ctx_)
    })
    client.commands.set('unban', async (msg, args) => {
        if (!msg.member?.permissions?.has(PermissionFlagsBits.BanMembers)) return
        await cmdUnban(msg, args[0]?.replace(/[<@!>]/g, ''), ctx_)
    })
    client.commands.set('kick', async (msg, args) => {
        if (!msg.member?.permissions?.has(PermissionFlagsBits.KickMembers)) return
        const target = await resolveTarget(msg, args, false, false)
        if (!target) return msg.reply('Say who — mention them or give me an ID.')
        await cmdKick(msg, target, args.slice(1).join(' ') || 'No reason provided', ctx_)
    })
    client.commands.set('mute', async (msg, args) => {
        if (!msg.member?.permissions?.has(PermissionFlagsBits.ModerateMembers)) return
        const target = await resolveTarget(msg, args, false, false)
        if (!target) return msg.reply('Say who — mention them or give me an ID.')
        await cmdMute(msg, target, args[1], args.slice(2).join(' ') || 'No reason provided', ctx_)
    })
    client.commands.set('unmute', async (msg, args) => {
        if (!msg.member?.permissions?.has(PermissionFlagsBits.ModerateMembers)) return
        const target = await resolveTarget(msg, args, false, false)
        if (!target) return msg.reply('Say who — mention them or give me an ID.')
        await cmdUnmute(msg, target, ctx_)
    })
    client.commands.set('warn', async (msg, args) => {
        if (!msg.member?.permissions?.has(PermissionFlagsBits.ModerateMembers)) return
        const target = await resolveTarget(msg, args, false, false)
        if (!target) return msg.reply('Say who — mention them or give me an ID.')
        await cmdWarn(msg, target, args.slice(1).join(' ') || 'No reason provided', ctx_)
    })
    client.commands.set('warnings', async (msg, args) => {
        if (!msg.member?.permissions?.has(PermissionFlagsBits.ModerateMembers)) return
        const target = await resolveTarget(msg, args)
        if (!target) return msg.reply('Member not found.')
        await cmdWarnings(msg, target, ctx_)
    })
    client.commands.set('whois', async (msg, args) => {
        if (!msg.guild) return msg.reply('❌ Server only.')
        const query = args.join(' ').trim().toLowerCase()
        if (!query) return msg.reply('❌ Give me a name to look up.')
        const cands = []
        for (const m of msg.guild.members.cache.values()) {
            const ns = [m.user?.username, m.user?.globalName, m.displayName, m.nickname]
            for (const n of ns) {
                if (n && String(n).toLowerCase().includes(query)) {
                    cands.push(m)
                    break
                }
            }
            if (cands.length >= 5) break
        }
        if (!cands.length) return msg.reply(`❌ No member matching \`${query.slice(0, 60)}\` found.`)
        await msg.reply(
            cands
                .map((m) => `**${m.displayName}** (@${m.user?.username ?? 'unknown'}) — <@${m.id}>`)
                .join('\n'),
        )
    })
    client.commands.set('modlog', async (msg, args) => {
        if (!msg.member?.permissions?.has(PermissionFlagsBits.ModerateMembers)) return
        const user = await resolveTarget(msg, args, true)
        await cmdModlog(msg, user === msg.author ? null : user, ctx_)
    })
    client.commands.set('clearwarns', async (msg, args) => {
        if (!msg.member?.permissions?.has(PermissionFlagsBits.ModerateMembers)) return
        const target = await resolveTarget(msg, args, false, false)
        if (!target) return msg.reply('Say who — mention them or give me an ID.')
        getStmts(db).clearWarns.run(String(msg.guild.id), String(target.id))
        await msg.reply({
            embeds: [
                modEmbed('Warnings Cleared', target.user ?? target, 'All active warnings cleared', msg.guild),
            ],
        })
    })
    client.commands.set('clear', async (msg, args) => {
        if (!msg.member?.permissions?.has(PermissionFlagsBits.ManageMessages)) return
        await cmdClear(msg, parseInt(args[0]) || 10)
        await msg.delete().catch(() => {})
    })
    client.commands.set('fpurge', async (msg, args) => {
        if (!msg.member?.permissions?.has(PermissionFlagsBits.ManageMessages)) return
        await msg.delete().catch(() => {})
        const text = args[0]
        const user = await resolveTarget(msg, args, true)
        const exact = args.includes('--exact')
        const limitM = args.join(' ').match(/--limit\s+(\d+)/)
        const afterM = args.join(' ').match(/--after\s+(\d+)/)
        const beforeM = args.join(' ').match(/--before\s+(\d+)/)
        await cmdFpurge(
            msg,
            text,
            user === msg.author ? null : user,
            exact,
            limitM ? parseInt(limitM[1]) : 100,
            beforeM?.[1],
            afterM?.[1],
        )
    })
    client.commands.set('mpurge', async (msg, args) => {
        if (!msg.member?.permissions?.has(PermissionFlagsBits.ManageMessages)) return
        await msg.delete().catch(() => {})
        const user = await resolveTarget(msg, args, true)
        if (!user || user === msg.author) return msg.channel.send('Target User not found.')
        const serverWide = args.includes('--server')
        const startM = args.join(' ').match(/--start\s+(\d+)/)
        await cmdMpurge(msg, user, serverWide, startM?.[1])
    })

    async function handleInteraction(interaction) {
        const { commandName } = interaction
        const perm = interaction.memberPermissions
        const noPerm = () =>
            interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral })
        // getMember() is null when the target left between opening the menu and
        // submitting — fail soft instead of throwing on member.id downstream.
        const missingMember = () =>
            interaction.reply({
                content: '❌ Member not found (they may have left).',
                flags: MessageFlags.Ephemeral,
            })

        if (commandName === 'ban') {
            if (!perm?.has(PermissionFlagsBits.BanMembers)) {
                await noPerm()
                return true
            }
            const m = interaction.options.getMember('member')
            if (!m) {
                await missingMember()
                return true
            }
            const r = interaction.options.getString('reason') ?? 'No reason provided'
            await cmdBan(interaction, m, r, ctx_)
            return true
        }
        if (commandName === 'unban') {
            if (!perm?.has(PermissionFlagsBits.BanMembers)) {
                await noPerm()
                return true
            }
            await cmdUnban(interaction, interaction.options.getString('user-id'), ctx_)
            return true
        }
        if (commandName === 'kick') {
            if (!perm?.has(PermissionFlagsBits.KickMembers)) {
                await noPerm()
                return true
            }
            const m = interaction.options.getMember('member')
            if (!m) {
                await missingMember()
                return true
            }
            await cmdKick(
                interaction,
                m,
                interaction.options.getString('reason') ?? 'No reason provided',
                ctx_,
            )
            return true
        }
        if (commandName === 'mute') {
            if (!perm?.has(PermissionFlagsBits.ModerateMembers)) {
                await noPerm()
                return true
            }
            const m = interaction.options.getMember('member')
            if (!m) {
                await missingMember()
                return true
            }
            await cmdMute(
                interaction,
                m,
                interaction.options.getString('duration'),
                interaction.options.getString('reason') ?? 'No reason provided',
                ctx_,
            )
            return true
        }
        if (commandName === 'unmute') {
            if (!perm?.has(PermissionFlagsBits.ModerateMembers)) {
                await noPerm()
                return true
            }
            const m = interaction.options.getMember('member')
            if (!m) {
                await missingMember()
                return true
            }
            await cmdUnmute(interaction, m, ctx_)
            return true
        }
        if (commandName === 'warn') {
            if (!perm?.has(PermissionFlagsBits.ModerateMembers)) {
                await noPerm()
                return true
            }
            const m = interaction.options.getMember('member')
            if (!m) {
                await missingMember()
                return true
            }
            await cmdWarn(
                interaction,
                m,
                interaction.options.getString('reason') ?? 'No reason provided',
                ctx_,
            )
            return true
        }
        if (commandName === 'warnings') {
            if (!perm?.has(PermissionFlagsBits.ModerateMembers)) {
                await noPerm()
                return true
            }
            const m = interaction.options.getMember('member')
            if (!m) {
                await missingMember()
                return true
            }
            await cmdWarnings(interaction, m, ctx_)
            return true
        }
        if (commandName === 'modlog') {
            if (!perm?.has(PermissionFlagsBits.ModerateMembers)) {
                await noPerm()
                return true
            }
            await cmdModlog(interaction, interaction.options.getUser('user') ?? null, ctx_)
            return true
        }
        if (commandName === 'erase') {
            if (!perm?.has(PermissionFlagsBits.ManageMessages)) {
                await noPerm()
                return true
            }
            await interaction.deferReply({})
            await cmdMpurge(
                interaction,
                interaction.options.getUser('user'),
                interaction.options.getBoolean('everywhere') ?? false,
                parseMessageRef(interaction.options.getString('start-from')),
            )
            return true
        }
        if (commandName === 'sweep') {
            if (!perm?.has(PermissionFlagsBits.ManageMessages)) {
                await noPerm()
                return true
            }
            const text = interaction.options.getString('text')
            const user = interaction.options.getUser('user')
            const startFrom = interaction.options.getString('start-from')
            const stopAt = interaction.options.getString('stop-at')
            if (!text && !user && !startFrom && !stopAt) {
                await interaction.reply({
                    content: '❌ Give me at least one filter: text, user, start-from or stop-at.',
                    flags: MessageFlags.Ephemeral,
                })
                return true
            }
            await interaction.deferReply({})
            await cmdFpurge(
                interaction,
                text,
                user,
                interaction.options.getBoolean('exact') ?? false,
                interaction.options.getInteger('scan') ?? 100,
                startFrom,
                stopAt,
            )
            return true
        }
        if (commandName === 'clear') {
            if (!perm?.has(PermissionFlagsBits.ManageMessages)) {
                await noPerm()
                return true
            }
            await interaction.deferReply({ flags: MessageFlags.Ephemeral })
            await cmdClear(interaction, interaction.options.getInteger('amount') ?? 10)
            return true
        }
        return false
    }

    async function handleMessage(message) {
        if (!isOwner(message.author.id)) return false
        if (!message.member?.permissions?.has(PermissionFlagsBits.ModerateMembers)) return false
        const content = (message.content ?? '').trim()
        const lower = content.toLowerCase()
        const now = Date.now()

        let matchedCmd = null,
            cmdType = null
        for (const cmd of MUTE_CMDS) {
            if (lower.startsWith(cmd.toLowerCase())) {
                matchedCmd = cmd
                cmdType = 'mute'
                break
            }
        }
        if (!matchedCmd)
            for (const cmd of BAN_CMDS) {
                if (lower.startsWith(cmd.toLowerCase())) {
                    matchedCmd = cmd
                    cmdType = 'ban'
                    break
                }
            }
        if (!matchedCmd)
            for (const cmd of UNMUTE_CMDS) {
                if (lower.startsWith(cmd.toLowerCase())) {
                    matchedCmd = cmd
                    cmdType = 'unmute'
                    break
                }
            }
        if (!matchedCmd) return false

        const parts = content.split(/\s+/)
        const cmdWords = matchedCmd.split(/\s+/).length
        const targetArg = parts[cmdWords]
        const target =
            message.mentions.members.first() ??
            (await message.guild.members.fetch(targetArg?.replace(/[<@!>]/g, '') || '').catch(() => null))
        if (!target) return false

        const gId = message.guild.id
        const userId = message.author.id

        if (cmdType === 'mute') {
            const dur = parts[cmdWords + 1]
            const reason = parts.slice(cmdWords + 2).join(' ') || 'No reason provided'
            const { delta, error } = parseTime(dur ?? '')
            if (!error) {
                await target.timeout(delta, reason)
                logAction(db, gId, target.id, userId, 'Mute', reason, dur)
                await message.channel.send({
                    embeds: [modEmbed('Mute', target.user, reason, message.guild, dur)],
                })
            }
        } else if (cmdType === 'ban') {
            const reason = parts.slice(cmdWords + 1).join(' ') || 'No reason provided'
            try {
                await message.guild.bans.fetch(target.id)
                await message.channel.send({ content: `🚫 ${target} is already banned.` })
            } catch {
                await retryOnce(() => target.ban({ reason }))
                logAction(db, gId, target.id, userId, 'Ban', reason)
                await message.channel.send({ embeds: [modEmbed('Ban', target.user, reason, message.guild)] })
            }
        } else if (cmdType === 'unmute') {
            if (target.communicationDisabledUntilTimestamp > now) {
                await target.timeout(null)
                logAction(db, gId, target.id, userId, 'Unmute', 'Unmuted')
                await message.channel.send({
                    embeds: [modEmbed('Unmute', target.user, 'Unmuted', message.guild)],
                })
            }
        }
        return true
    }

    return {
        handleInteraction,
        handleMessage,
        logAction: (gId, uId, mId, action, reason, dur) => logAction(db, gId, uId, mId, action, reason, dur),
        parseTime,
        formatDuration,
        modEmbed: (action, member, reason, guild, duration) =>
            modEmbed(action, member, reason, guild, duration),
        retryOnce,
    }
}
