import { formatDuration } from './utils.js'

export function registerAfk(client, db = null) {
    const afkData = new Map()
    const userCooldowns = new Map()
    const mentionCounts = new Map()

    // With a db handle AFK survives restarts; without one it degrades to memory-only.
    if (db)
        db.prepare(
            'CREATE TABLE IF NOT EXISTS afk_status (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, reason TEXT, timestamp INTEGER, PRIMARY KEY (guild_id, user_id))',
        ).run()
    const stmts = db && {
        set: db.prepare(
            'INSERT OR REPLACE INTO afk_status (guild_id, user_id, reason, timestamp) VALUES (?, ?, ?, ?)',
        ),
        del: db.prepare('DELETE FROM afk_status WHERE guild_id = ? AND user_id = ?'),
        delGuild: db.prepare('DELETE FROM afk_status WHERE guild_id = ?'),
        all: db.prepare('SELECT * FROM afk_status'),
    }
    if (stmts)
        for (const row of stmts.all.all()) {
            if (!afkData.has(row.guild_id)) afkData.set(row.guild_id, new Map())
            afkData
                .get(row.guild_id)
                .set(row.user_id, { reason: row.reason, timestamp: row.timestamp })
        }

    function afkGuild(gid) {
        if (!afkData.has(gid)) afkData.set(gid, new Map())
        if (!userCooldowns.has(gid)) userCooldowns.set(gid, new Map())
        if (!mentionCounts.has(gid)) mentionCounts.set(gid, new Map())
        return { afk: afkData.get(gid), cd: userCooldowns.get(gid), mc: mentionCounts.get(gid) }
    }

    client.on('guildDelete', (guild) => {
        afkData.delete(guild.id)
        userCooldowns.delete(guild.id)
        mentionCounts.delete(guild.id)
        stmts?.delGuild.run(guild.id)
    })

    client.commands.set('afk', async (msg, args) => {
        const reason = args.join(' ') || 'AFK'
        const { afk } = afkGuild(msg.guild.id)
        const entry = { reason, timestamp: Math.floor(Date.now() / 1000) }
        afk.set(msg.author.id, entry)
        stmts?.set.run(msg.guild.id, msg.author.id, entry.reason, entry.timestamp)
        if (!msg.member.displayName.startsWith('[🪼] '))
            msg.member.setNickname(`[🪼] ${msg.member.displayName}`).catch(() => {})
        await msg.reply({
            content: `> 🪼 | <@${msg.author.id}> **is now AFK** - ${reason}`,
            allowedMentions: { parse: [] },
        })
    })

    client.commands.set('unafk', async (msg) => {
        const { afk } = afkGuild(msg.guild.id)
        if (afk.has(msg.author.id)) {
            afk.delete(msg.author.id)
            stmts?.del.run(msg.guild.id, msg.author.id)
            const nick = msg.member.displayName
            if (nick.startsWith('[🪼] ')) msg.member.setNickname(nick.slice(5)).catch(() => {})
            await msg.reply({
                content: `> 🪼 | <@${msg.author.id}> **is back.**`,
                allowedMentions: { parse: [] },
            })
        } else {
            await msg.reply({
                content: `> 🪼 | <@${msg.author.id}> **was not AFK.**`,
                allowedMentions: { parse: [] },
            })
        }
    })

    async function handleMessage(message) {
        const gId = message.guild.id
        const userId = message.author.id
        const now = Math.floor(Date.now() / 1000)
        const { afk, cd, mc } = afkGuild(gId)

        if (afk.has(userId)) {
            afk.delete(userId)
            stmts?.del.run(gId, userId)
            mc.clear()
            if (message.member?.displayName.startsWith('[🪼] '))
                message.member.setNickname(message.member.displayName.slice(5)).catch(() => {})
            await message.channel.send({
                content: `> 🪼 | <@${userId}> **is back.**`,
                allowedMentions: { parse: [] },
            })
        }

        for (const [afkId, data] of afk) {
            if (afkId === userId) continue
            const mentioned = message.mentions.users.has(afkId)
            const isReply = message.reference?.resolved?.author.id === afkId
            if (!mentioned && !isReply) continue
            const cdExp = cd.get(userId) ?? 0
            if (now < cdExp) break
            const count = (mc.get(userId) ?? 0) + 1
            mc.set(userId, count)
            if (count > 3) {
                cd.set(userId, now + 30)
                mc.set(userId, 0)
            }
            const elapsed = data.timestamp ? formatDuration((now - data.timestamp) * 1000) : ''
            const afkMember = message.guild.members.cache.get(afkId)
            const afkName = afkMember?.displayName ?? 'AFK User'
            let reply = `> 🪼 | ${afkName} **${data.reason}**`
            if (elapsed) reply += `\n⏰ \`${elapsed}\``
            await message.reply({ content: reply, allowedMentions: { parse: [] } })
            break
        }
    }

    return { handleMessage }
}
