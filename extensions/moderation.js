import {
    ActionRowBuilder, ButtonBuilder, ButtonStyle,
    ComponentType, EmbedBuilder, MessageFlags, PermissionFlagsBits
} from 'discord.js'
import { formatDuration, parseTime, resolveTarget } from './utils.js'

export { formatDuration, parseTime }



export function logAction(db, guildId, userId, modId, action, reason, duration = null) {
    try {
        db.prepare(
            'INSERT INTO mod_logs (guild_id, user_id, moderator_id, action, reason, duration) VALUES (?,?,?,?,?,?)'
        ).run(String(guildId), String(userId), String(modId), action, reason, duration ?? 'N/A')
    } catch (e) { console.error('[logAction]', e) }
}

export function canModerate(author, target, guild) {
    const authorPos = author.roles?.highest?.position ?? 0
    const targetPos = target.roles?.highest?.position ?? 0
    if (guild.ownerId === String(author.id ?? author.user?.id)) return true
    return authorPos > targetPos
}

export async function sendDMNotif(member, action, guild, reason, duration = null) {
    try {
        const embed = new EmbedBuilder()
            .setTitle('Mod Action Notification')
            .setDescription(`👁️ | You've been ${action.toLowerCase()} in **${guild.name}**${duration ? ` for **${duration}**` : ''}.\nReason: \`${reason}\``)
            .setColor(0x378ADD)
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
        .setColor(0x378ADD)
    if (guild.iconURL()) embed.setFooter({ text: guild.name, iconURL: guild.iconURL() })
    return embed
}

export async function safeDelete(msg, delay = 800) {
    try { await msg.delete(); await new Promise(r => setTimeout(r, delay)); return true }
    catch { return false }
}

export async function retryOnce(fn) {
    try { return await fn() }
    catch (e) { await new Promise(r => setTimeout(r, 1500)); return fn() }
}

export async function cmdBan(ctx, member, reason, { db, BOT_OWNER_ID, memeGuildId }) {
    const guild  = ctx.guild
    const author = ctx.member ?? ctx.user
    if (BigInt(member.id) === BOT_OWNER_ID) return ctx.reply({ content: '🚫 | You cannot ban the bot owner.' })
    if (!canModerate(author, member, guild)) return ctx.reply({ content: '🚫 You cannot ban someone with an equal or higher role.' })
    if (member.bannable === false) return ctx.reply({ content: `🚫 I don't have enough permission hierarchy to ban ${member}!` })
    try { await guild.bans.fetch(member.id); return ctx.reply({ content: `🚫 ${member} is already banned.` }) } catch {}
    try {
        await guild.members.ban(member, { reason })
        await sendDMNotif(member.user ?? member, 'Ban', guild, reason).catch(() => null)
        logAction(db, guild.id, member.id, author.id, 'Ban', reason)
        await ctx.reply({ embeds: [modEmbed('Ban', member.user ?? member, reason, guild, null, memeGuildId)] })
    } catch (e) { await ctx.reply({ content: `❌ Error trying to ban: ${e.message}` }) }
}

export async function cmdUnban(ctx, userId, { db }) {
    const guild  = ctx.guild
    const author = ctx.member ?? ctx.user
    try {
        const ban = await guild.bans.fetch(userId)
        await guild.members.unban(userId, 'Unbanned')
        logAction(db, guild.id, userId, author.id, 'Unban', 'Unbanned')
        await ctx.reply({ embeds: [modEmbed('Unban', ban.user, 'Unbanned', guild)] })
    } catch { await ctx.reply({ content: '🚫 User not found in ban list.' }) }
}

export async function cmdMute(ctx, member, durationStr, reason, { db, BOT_OWNER_ID, memeGuildId }) {
    const guild  = ctx.guild
    const author = ctx.member ?? ctx.user
    if (BigInt(member.id) === BOT_OWNER_ID) return ctx.reply({ content: '🚫 | You cannot mute the bot owner.' })
    if (!canModerate(author, member, guild)) return ctx.reply({ content: '🚫 You cannot mute someone with an equal or higher role.' })
    if (member.moderatable === false) return ctx.reply({ content: `🚫 I don't have enough permission hierarchy to mute ${member}!` })
    if (member.communicationDisabledUntilTimestamp > Date.now()) return ctx.reply({ content: `🚫 ${member} is already muted.` })
    const { delta, error } = parseTime(durationStr)
    if (error) return ctx.reply({ content: error })
    try {
        await member.timeout(delta, reason)
        await sendDMNotif(member.user, 'Mute', guild, reason, durationStr).catch(() => null)
        logAction(db, guild.id, member.id, author.id, 'Mute', reason, durationStr)
        await ctx.reply({ embeds: [modEmbed('Mute', member.user, reason, guild, durationStr, memeGuildId)] })
    } catch (e) { await ctx.reply({ content: `❌ Error trying to mute: ${e.message}` }) }
}

export async function cmdUnmute(ctx, member, { db, memeGuildId }) {
    const guild  = ctx.guild
    const author = ctx.member ?? ctx.user
    if (!member.communicationDisabledUntilTimestamp || member.communicationDisabledUntilTimestamp <= Date.now())
        return ctx.reply({ content: `🚫 ${member} is not muted.` })
    await sendDMNotif(member.user, 'Unmute', guild, 'Unmuted')
    await member.timeout(null)
    logAction(db, guild.id, member.id, author.id, 'Unmute', 'Unmuted')
    await ctx.reply({ embeds: [modEmbed('Unmute', member.user, 'Unmuted', guild, null, memeGuildId)] })
}

export async function cmdWarn(ctx, member, reason, { db, BOT_OWNER_ID }) {
    const guild  = ctx.guild
    const author = ctx.member ?? ctx.user
    if (BigInt(member.id) === BOT_OWNER_ID) return ctx.reply({ content: '🚫 | You cannot warn the bot owner.' })
    if ((member.roles?.highest?.comparePositionTo(author.roles?.highest) ?? -1) >= 0 && BigInt(author.id) !== BOT_OWNER_ID)
        return ctx.reply({ content: '🚫 You cannot warn someone with an equal or higher role.' })
    const result = db.prepare(
        'INSERT INTO warnings (guild_id, user_id, moderator_id, reason) VALUES (?,?,?,?)'
    ).run(String(guild.id), String(member.id), String(author.id), reason)
    await sendDMNotif(member.user, 'Warned', guild, reason)
    await ctx.reply({ embeds: [new EmbedBuilder()
        .setTitle('⚠️ User Warned')
        .setDescription(`👤 **Member:** ${member} (\`${member.id}\`)\n📌 **Reason:** ${reason}\n🆔 **Warning ID:** #${result.lastInsertRowid}`)
        .setColor(0xEF9F27)
        .setFooter({ text: guild.name, iconURL: guild.iconURL() ?? undefined })] })
}

export async function cmdWarnings(ctx, member, { db }) {
    const rows = db.prepare(
        'SELECT id, moderator_id, reason, timestamp FROM warnings WHERE guild_id=? AND user_id=? AND active=TRUE ORDER BY timestamp DESC'
    ).all(String(ctx.guild.id), String(member.id))
    if (!rows.length) return ctx.reply({ content: `${member} has no active warnings.` })
    const embed = new EmbedBuilder().setTitle(`⚠️ Warnings for ${member.displayName}`).setColor(0xEF9F27)
    for (const { id, moderator_id, reason, timestamp } of rows.slice(0, 10)) {
        const mod = ctx.guild.members.cache.get(String(moderator_id))
        embed.addFields({ name: `Warning #${id}`, value: `**Moderator:** ${mod ?? `<@${moderator_id}>`}\n**Reason:** ${reason}\n**Date:** ${timestamp.slice(0, 10)}`, inline: false })
    }
    if (rows.length > 10) embed.setFooter({ text: `Showing 10 of ${rows.length} warnings` })
    await ctx.reply({ embeds: [embed] })
}

export async function cmdModlog(ctx, user, { db }) {
    const gId = String(ctx.guild.id)
    const uid = user ? String(user.id) : null
    const modRows = uid
        ? db.prepare('SELECT user_id, moderator_id, action, reason, duration, timestamp FROM mod_logs WHERE guild_id=? AND (user_id=? OR moderator_id=?) ORDER BY timestamp DESC').all(gId, uid, uid)
        : db.prepare('SELECT user_id, moderator_id, action, reason, duration, timestamp FROM mod_logs WHERE guild_id=? ORDER BY timestamp DESC').all(gId)
    const warnRows = uid
        ? db.prepare('SELECT user_id, moderator_id, reason, timestamp FROM warnings WHERE guild_id=? AND (user_id=? OR moderator_id=?) AND active=TRUE ORDER BY timestamp DESC').all(gId, uid, uid)
        : db.prepare('SELECT user_id, moderator_id, reason, timestamp FROM warnings WHERE guild_id=? AND active=TRUE ORDER BY timestamp DESC').all(gId)
    const logs = [
        ...modRows.map(r => { const dur = r.duration && r.duration !== 'N/A' ? ` | **Duration:** ${r.duration}` : ''; return `**${r.action}** - <@${r.user_id}> | **Reason:** ${r.reason} | **By:** <@${r.moderator_id}> | **Date:** ${r.timestamp.slice(0, 16)}${dur}` }),
        ...warnRows.map(r => `**Warn** - <@${r.user_id}> | **Reason:** ${r.reason} | **By:** <@${r.moderator_id}> | **Date:** ${r.timestamp.slice(0, 16)}`),
    ]
    if (!logs.length) return ctx.reply({ content: user ? `No moderation logs found for ${user}.` : 'No moderation logs found.', flags: MessageFlags.Ephemeral })
    const PER = 20
    const pages = Math.ceil(logs.length / PER)
    let cur = 0
    const mkEmbed = (p) => new EmbedBuilder()
        .setTitle(user ? `📜 Moderation Logs - ${user.username}` : '📜 Moderation Logs')
        .setDescription(logs.slice(p * PER, (p + 1) * PER).join('\n'))
        .setColor(0x378ADD)
        .setFooter({ text: pages > 1 ? `Page ${p + 1}/${pages} • Total: ${logs.length}` : `Total: ${logs.length}` })
    const mkRow = (p) => new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ml_prev').setEmoji('⬅️').setStyle(ButtonStyle.Secondary).setDisabled(p === 0),
        new ButtonBuilder().setCustomId('ml_next').setEmoji('➡️').setStyle(ButtonStyle.Secondary).setDisabled(p >= pages - 1),
        new ButtonBuilder().setCustomId('ml_del').setEmoji('❌').setStyle(ButtonStyle.Danger),
    )
    await ctx.reply({ embeds: [mkEmbed(0)], components: [mkRow(0)] })
    const send = await ctx.fetchReply()
    if (pages <= 1 && !send) return
    const col = send.createMessageComponentCollector({ componentType: ComponentType.Button, time: 60_000 })
    col.on('collect', async i => {
        const auth = ctx.user ?? ctx.author
        if (i.user.id !== auth?.id) return i.reply({ content: 'Only the command user can use these buttons.', flags: MessageFlags.Ephemeral })
        if (i.customId === 'ml_del') { col.stop(); return i.update({ components: [] }) }
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
    try { const msgs = await chan.bulkDelete(amount, true); deleted = msgs.size }
    catch { return send({ content: '❌ Failed to delete messages.' }) }
    const embed = new EmbedBuilder()
        .setTitle('Messages Cleared 🐍')
        .setDescription(`✅ **Deleted \`${deleted}\` messages by ${ctx.user ?? ctx.author}**`)
        .setColor(0x378ADD).setTimestamp()
    if (ctx.guild?.iconURL()) embed.setFooter({ text: ctx.guild.name, iconURL: ctx.guild.iconURL() })
    await send({ embeds: [embed] })
}

export async function cmdFpurge(ctx, text, user = null, exact = false, limit = 100, afterId = null, beforeId = null) {
    const send = (ctx.deferred || ctx.replied) ? (data) => ctx.editReply(data) : (data) => ctx.reply(data)
    try {
        let found = 0, checked = 0
        let lastId = null
        const targetId = user?.id ?? null
        const searchText = (text ?? '').toLowerCase()
        while (checked < limit) {
            const fetchOpts = { limit: Math.min(100, limit - checked) }
            if (afterId && !lastId)  fetchOpts.after  = afterId
            if (beforeId && !lastId) fetchOpts.before = beforeId
            if (lastId) fetchOpts.before = lastId
            const msgs = await ctx.channel.messages.fetch(fetchOpts)
            if (!msgs.size) break
            checked += msgs.size
            lastId = msgs.last()?.id
            const toDelete = msgs.filter(m => {
                if (targetId && m.author.id !== targetId) return false
                const content = m.content.toLowerCase()
                return exact ? content === searchText : content.includes(searchText)
            })
            if (toDelete.size) { await ctx.channel.bulkDelete(toDelete, true); found += toDelete.size }
        }
        await send({ content: `✅ Deleted **${found}** matching messages (scanned ${checked}).` })
    } catch (e) { await send({ content: `❌ Failed: ${e.message}` }) }
}

async function processChannel(client, channel, targetUser, cutoffTs, startFromId = null) {
    let deleted = 0, lastId = startFromId
    while (true) {
        const opts = { limit: 100 }
        if (lastId) opts.before = lastId
        const msgs = await channel.messages.fetch(opts).catch(() => null)
        if (!msgs?.size) break
        const toDelete = msgs.filter(m => m.author.id === targetUser.id && m.createdTimestamp >= cutoffTs)
        if (toDelete.size) { await channel.bulkDelete(toDelete, true).catch(() => {}); deleted += toDelete.size }
        if (msgs.size < 100) break
        lastId = msgs.last()?.id
        await new Promise(r => setTimeout(r, 200))
    }
    return deleted
}

export async function cmdMpurge(ctx, targetUser, serverWide = false, startFromId = null) {
    const send = (ctx.deferred || ctx.replied) ? (data) => ctx.editReply(data) : (data) => ctx.reply(data)
    const cutoffTs = Date.now() - (14 * 24 * 60 * 60 * 1000)
    let total = 0
    try {
        if (serverWide) {
            const channels = ctx.guild.channels.cache.filter(c => c.isTextBased())
            for (const ch of channels.values()) total += await processChannel(ctx.client, ch, targetUser, cutoffTs)
        } else {
            total += await processChannel(ctx.client, ctx.channel, targetUser, cutoffTs, startFromId)
        }
        await send({ content: `✅ Deleted **${total}** messages from **${targetUser.username}**${serverWide ? ' (server-wide)' : ''}.` })
    } catch (e) { await send({ content: `❌ Failed: ${e.message}` }) }
}

export function registerModeration(client, db, config) {
    const BOT_OWNER_ID = config.owner_id ? BigInt(config.owner_id) : 0n
    const ctx_        = { db, BOT_OWNER_ID }
    const isOwner     = (id) => BigInt(id) === BOT_OWNER_ID

    // Custom keyword trigger phrases — configure in config.json to enable. (for funsies like the old days)
    // e.g. "mute_phrases": ["quiet", "shh"], "ban_phrases": ["get out"]
    const MUTE_CMDS  = config.mute_phrases  ?? []
    const BAN_CMDS   = config.ban_phrases   ?? []
    const UNMUTE_CMDS= config.unmute_phrases?? []

    client.commands.set('ban', async (msg, args) => {
        if (!msg.member.permissions.has(PermissionFlagsBits.BanMembers)) return
        const target = await resolveTarget(msg, args)
        if (!target) return msg.reply('Member not found.')
        await cmdBan(msg, target, args.slice(1).join(' ') || 'No reason provided', ctx_)
    })
    client.commands.set('unban', async (msg, args) => {
        if (!msg.member.permissions.has(PermissionFlagsBits.BanMembers)) return
        await cmdUnban(msg, args[0]?.replace(/[<@!>]/g, ''), ctx_)
    })
    client.commands.set('mute', async (msg, args) => {
        if (!msg.member.permissions.has(PermissionFlagsBits.ModerateMembers)) return
        const target = await resolveTarget(msg, args)
        if (!target) return msg.reply('Member not found.')
        await cmdMute(msg, target, args[1], args.slice(2).join(' ') || 'No reason provided', ctx_)
    })
    client.commands.set('unmute', async (msg, args) => {
        if (!msg.member.permissions.has(PermissionFlagsBits.ModerateMembers)) return
        const target = await resolveTarget(msg, args)
        if (!target) return msg.reply('Member not found.')
        await cmdUnmute(msg, target, ctx_)
    })
    client.commands.set('warn', async (msg, args) => {
        if (!msg.member.permissions.has(PermissionFlagsBits.ModerateMembers)) return
        const target = await resolveTarget(msg, args)
        if (!target) return msg.reply('Member not found.')
        await cmdWarn(msg, target, args.slice(1).join(' ') || 'No reason provided', ctx_)
    })
    client.commands.set('warnings', async (msg, args) => {
        if (!msg.member.permissions.has(PermissionFlagsBits.ModerateMembers)) return
        const target = await resolveTarget(msg, args)
        if (!target) return msg.reply('Member not found.')
        await cmdWarnings(msg, target, ctx_)
    })
    client.commands.set('modlog', async (msg, args) => {
        if (!msg.member.permissions.has(PermissionFlagsBits.ModerateMembers)) return
        const user = await resolveTarget(msg, args, true)
        await cmdModlog(msg, user === msg.author ? null : user, ctx_)
    })
    client.commands.set('clearwarns', async (msg, args) => {
        if (!msg.member.permissions.has(PermissionFlagsBits.ModerateMembers)) return
        const target = await resolveTarget(msg, args)
        if (!target) return msg.reply('Member not found.')
        db.prepare('UPDATE warnings SET active=FALSE WHERE guild_id=? AND user_id=?').run(String(msg.guild.id), String(target.id))
        await msg.reply({ embeds: [modEmbed('Warnings Cleared', target.user ?? target, 'All active warnings cleared', msg.guild)] })
    })
    client.commands.set('clear', async (msg, args) => {
        if (!msg.member.permissions.has(PermissionFlagsBits.ManageMessages)) return
        await cmdClear(msg, parseInt(args[0]) || 10)
        await msg.delete().catch(() => {})
    })
    client.commands.set('fpurge', async (msg, args) => {
        if (!msg.member.permissions.has(PermissionFlagsBits.ManageMessages)) return
        await msg.delete().catch(() => {})
        const text   = args[0]
        const user   = await resolveTarget(msg, args, true)
        const exact  = args.includes('--exact')
        const limitM = args.join(' ').match(/--limit\s+(\d+)/)
        const afterM = args.join(' ').match(/--after\s+(\d+)/)
        const beforeM= args.join(' ').match(/--before\s+(\d+)/)
        await cmdFpurge(msg, text, user === msg.author ? null : user, exact, limitM ? parseInt(limitM[1]) : 100, afterM?.[1], beforeM?.[1])
    })
    client.commands.set('mpurge', async (msg, args) => {
        if (!msg.member.permissions.has(PermissionFlagsBits.ManageMessages)) return
        await msg.delete().catch(() => {})
        const user = await resolveTarget(msg, args, true)
        if (!user || user === msg.author) return msg.reply('Target User not found.')
        const serverWide = args.includes('--server')
        const startM     = args.join(' ').match(/--start\s+(\d+)/)
        await cmdMpurge(msg, user, serverWide, startM?.[1])
    })

    async function handleInteraction(interaction) {
        const { commandName } = interaction
        const perm = interaction.memberPermissions

        if (commandName === 'ban') {
            const m = interaction.options.getMember('member')
            const r = interaction.options.getString('reason') ?? 'No reason provided'
            await cmdBan(interaction, m, r, ctx_)
            return true
        }
        if (commandName === 'unban') {
            await cmdUnban(interaction, interaction.options.getString('user_id'), ctx_)
            return true
        }
        if (commandName === 'mute') {
            await cmdMute(interaction, interaction.options.getMember('member'), interaction.options.getString('duration'), interaction.options.getString('reason') ?? 'No reason provided', ctx_)
            return true
        }
        if (commandName === 'unmute') {
            await cmdUnmute(interaction, interaction.options.getMember('member'), ctx_)
            return true
        }
        if (commandName === 'warn') {
            await cmdWarn(interaction, interaction.options.getMember('member'), interaction.options.getString('reason') ?? 'No reason provided', ctx_)
            return true
        }
        if (commandName === 'warnings') {
            await cmdWarnings(interaction, interaction.options.getMember('member'), ctx_)
            return true
        }
        if (commandName === 'modlog') {
            await cmdModlog(interaction, interaction.options.getUser('user') ?? null, ctx_)
            return true
        }
        if (commandName === 'mpurge') {
            await cmdMpurge(interaction, interaction.options.getUser('user'), interaction.options.getBoolean('server_wide') ?? false, interaction.options.getString('start_from_id') ?? null)
            return true
        }
        if (commandName === 'filter_purge') {
            await interaction.deferReply({})
            await cmdFpurge(interaction, interaction.options.getString('text'), interaction.options.getUser('user'), interaction.options.getBoolean('exact') ?? false, interaction.options.getInteger('limit') ?? 100, interaction.options.getString('after_id'), interaction.options.getString('before_id'))
            return true
        }
        if (commandName === 'clear') {
            if (!perm?.has(PermissionFlagsBits.ManageMessages)) { await interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral }); return true }
            await interaction.deferReply({ flags: MessageFlags.Ephemeral })
            await cmdClear(interaction, interaction.options.getInteger('amount') ?? 10)
            return true
        }
        return false
    }

    async function handleMessage(message) {
        if (!isOwner(message.author.id)) return false
        if (!message.member?.permissions.has(PermissionFlagsBits.ModerateMembers)) return false
        const content = message.content.trim()
        const lower   = content.toLowerCase()
        const now     = Date.now()

        let matchedCmd = null, cmdType = null
        for (const cmd of MUTE_CMDS)   { if (lower.startsWith(cmd.toLowerCase())) { matchedCmd = cmd; cmdType = 'mute';   break } }
        if (!matchedCmd) for (const cmd of BAN_CMDS)    { if (lower.startsWith(cmd.toLowerCase())) { matchedCmd = cmd; cmdType = 'ban';    break } }
        if (!matchedCmd) for (const cmd of UNMUTE_CMDS) { if (lower.startsWith(cmd.toLowerCase())) { matchedCmd = cmd; cmdType = 'unmute'; break } }
        if (!matchedCmd) return false

        const parts    = content.split(/\s+/)
        const cmdWords = matchedCmd.split(/\s+/).length
        const targetArg= parts[cmdWords]
        const target   = message.mentions.members.first() ??
            await message.guild.members.fetch(targetArg?.replace(/[<@!>]/g, '') || '').catch(() => null)
        if (!target) return false

        const gId   = message.guild.id
        const userId= message.author.id

        if (cmdType === 'mute') {
            const dur    = parts[cmdWords + 1]
            const reason = parts.slice(cmdWords + 2).join(' ') || 'No reason provided'
            const { delta, error } = parseTime(dur ?? '')
            if (!error) { await target.timeout(delta, reason); logAction(db, gId, target.id, userId, 'Mute', reason, dur); await message.channel.send({ embeds: [modEmbed('Mute', target.user, reason, message.guild, dur)] }) }
        } else if (cmdType === 'ban') {
            const reason = parts.slice(cmdWords + 1).join(' ') || 'No reason provided'
            try { await message.guild.bans.fetch(target.id); await message.channel.send({ content: `🚫 ${target} is already banned.` }) }
            catch { await retryOnce(() => target.ban({ reason })); logAction(db, gId, target.id, userId, 'Ban', reason); await message.channel.send({ embeds: [modEmbed('Ban', target.user, reason, message.guild)] }) }
        } else if (cmdType === 'unmute') {
            if (target.communicationDisabledUntilTimestamp > now) { await target.timeout(null); logAction(db, gId, target.id, userId, 'Unmute', 'Unmuted'); await message.channel.send({ embeds: [modEmbed('Unmute', target.user, 'Unmuted', message.guild)] }) }
        }
        return true
    }

    return { handleInteraction, handleMessage, logAction: (gId, uId, mId, action, reason, dur) => logAction(db, gId, uId, mId, action, reason, dur), parseTime, formatDuration, modEmbed: (action, member, reason, guild, duration) => modEmbed(action, member, reason, guild, duration), retryOnce }
}
