import { formatDuration } from './utils.js'

const AFK_PREFIX = '[🪼] '

function buildAfkNick(displayName) {
    if (!displayName || displayName.startsWith(AFK_PREFIX)) return null
    const maxBase = 32 - AFK_PREFIX.length
    let base = displayName
    if (base.length > maxBase) {
        base = base.slice(0, maxBase)
        const last = base.charCodeAt(base.length - 1)
        if (last >= 0xd800 && last <= 0xdbff) base = base.slice(0, -1)
    }
    return `${AFK_PREFIX}${base}`
}

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
            afkData.get(row.guild_id).set(row.user_id, { reason: row.reason, timestamp: row.timestamp })
        }

    function afkGuild(gid) {
        if (!afkData.has(gid)) afkData.set(gid, new Map())
        if (!userCooldowns.has(gid)) userCooldowns.set(gid, new Map())
        if (!mentionCounts.has(gid)) mentionCounts.set(gid, new Map())
        return { afk: afkData.get(gid), cd: userCooldowns.get(gid), mc: mentionCounts.get(gid) }
    }

    // Periodically prune expired cooldowns and stale mention counters
    setInterval(() => {
        const now = Math.floor(Date.now() / 1000)
        for (const [gid, cd] of userCooldowns) {
            for (const [uid, exp] of cd) {
                if (now >= exp) cd.delete(uid)
            }
            if (!cd.size) userCooldowns.delete(gid)
        }
        for (const [gid, mc] of mentionCounts) {
            const cd = userCooldowns.get(gid)
            for (const uid of mc.keys()) {
                if (!cd?.has(uid)) mc.delete(uid)
            }
            if (!mc.size) mentionCounts.delete(gid)
        }
    }, 5 * 60_000).unref()

    client.on('guildDelete', (guild) => {
        afkData.delete(guild.id)
        userCooldowns.delete(guild.id)
        mentionCounts.delete(guild.id)
        stmts?.delGuild.run(guild.id)
    })

    client.commands.set('afk', async (msg, args) => {
        if (!msg.guild) return
        const reason = args.join(' ') || 'AFK'
        const { afk } = afkGuild(msg.guild.id)
        const entry = { reason, timestamp: Math.floor(Date.now() / 1000) }
        afk.set(msg.author.id, entry)
        stmts?.set.run(msg.guild.id, msg.author.id, entry.reason, entry.timestamp)
        const nextNick = buildAfkNick(msg.member?.displayName)
        if (nextNick) msg.member.setNickname(nextNick).catch(() => {})
        await msg.reply({
            content: `> 🪼 | <@${msg.author.id}> **is now AFK** - ${reason}`,
            allowedMentions: { parse: [] },
        })
    })

    client.commands.set('unafk', async (msg) => {
        if (!msg.guild) return
        const { afk } = afkGuild(msg.guild.id)
        if (afk.has(msg.author.id)) {
            afk.delete(msg.author.id)
            stmts?.del.run(msg.guild.id, msg.author.id)
            const nick = msg.member?.displayName
            if (nick?.startsWith(AFK_PREFIX))
                msg.member.setNickname(nick.slice(AFK_PREFIX.length)).catch(() => {})
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
        const gId = message.guild?.id
        if (!gId) return
        const afk = afkData.get(gId)
        if (!afk?.size) return

        const userId = message.author.id
        const now = Math.floor(Date.now() / 1000)
        const { cd, mc } = afkGuild(gId)

        if (afk.has(userId)) {
            afk.delete(userId)
            stmts?.del.run(gId, userId)
            mc.delete(userId)
            const nick = message.member?.displayName
            if (nick?.startsWith(AFK_PREFIX))
                message.member.setNickname(nick.slice(AFK_PREFIX.length)).catch(() => {})
            await message.channel.send({
                content: `> 🪼 | <@${userId}> **is back.**`,
                allowedMentions: { parse: [] },
            })
        }

        if (!afk.size) return

        // Check only explicitly mentioned and replied user IDs (O(mentions))
        const candidates = new Set()
        for (const id of message.mentions.users.keys()) {
            if (id !== userId) candidates.add(id)
        }
        const repliedId =
            message.mentions.repliedUser?.id ??
            (message.reference?.messageId
                ? message.channel?.messages?.cache?.get(message.reference.messageId)?.author?.id
                : null)
        if (repliedId && repliedId !== userId) candidates.add(repliedId)

        for (const afkId of candidates) {
            const data = afk.get(afkId)
            if (!data) continue
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
