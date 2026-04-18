import { formatDuration } from './utils.js'

export function registerAfk(client) {
    const afkData       = new Map()
    const userCooldowns = new Map()
    const mentionCounts = new Map()

    function afkGuild(gid) {
        if (!afkData.has(gid))       afkData.set(gid, new Map())
        if (!userCooldowns.has(gid)) userCooldowns.set(gid, new Map())
        if (!mentionCounts.has(gid)) mentionCounts.set(gid, new Map())
        return { afk: afkData.get(gid), cd: userCooldowns.get(gid), mc: mentionCounts.get(gid) }
    }

    client.on('guildDelete', guild => {
        afkData.delete(guild.id)
        userCooldowns.delete(guild.id)
        mentionCounts.delete(guild.id)
    })

    client.commands.set('afk', async (msg, args) => {
        const reason = args.join(' ') || 'AFK'
        const { afk } = afkGuild(msg.guild.id)
        afk.set(msg.author.id, { reason, timestamp: Math.floor(Date.now() / 1000) })
        if (!msg.member.displayName.startsWith('[🪼] '))
            msg.member.setNickname(`[🪼] ${msg.member.displayName}`).catch(() => {})
        await msg.reply({ content: `> 🪼 | <@${msg.author.id}> **is now AFK** - ${reason}`, allowedMentions: { parse: [] } })
    })

    client.commands.set('unafk', async (msg) => {
        const { afk } = afkGuild(msg.guild.id)
        if (afk.has(msg.author.id)) {
            afk.delete(msg.author.id)
            const nick = msg.member.displayName
            if (nick.startsWith('[🪼] ')) msg.member.setNickname(nick.slice(5)).catch(() => {})
            await msg.reply({ content: `> 🪼 | <@${msg.author.id}> **is back.**`, allowedMentions: { parse: [] } })
        } else {
            await msg.reply({ content: `> 🪼 | <@${msg.author.id}> **was not AFK.**`, allowedMentions: { parse: [] } })
        }
    })

    async function handleMessage(message) {
        const gId    = message.guild.id
        const userId = message.author.id
        const now    = Math.floor(Date.now() / 1000)
        const { afk, cd, mc } = afkGuild(gId)

        if (afk.has(userId)) {
            afk.delete(userId)
            mc.clear()
            if (message.member?.displayName.startsWith('[🪼] '))
                message.member.setNickname(message.member.displayName.slice(5)).catch(() => {})
            await message.channel.send({ content: `> 🪼 | <@${userId}> **is back.**`, allowedMentions: { parse: [] } })
        }

        for (const [afkId, data] of afk) {
            if (afkId === userId) continue
            const mentioned = message.mentions.users.has(afkId)
            const isReply   = message.reference?.resolved?.author.id === afkId
            if (!mentioned && !isReply) continue
            const cdExp = cd.get(userId) ?? 0
            if (now < cdExp) break
            const count = (mc.get(userId) ?? 0) + 1
            mc.set(userId, count)
            if (count > 3) { cd.set(userId, now + 30); mc.set(userId, 0) }
            const elapsed   = data.timestamp ? formatDuration((now - data.timestamp) * 1000) : ''
            const afkMember = message.guild.members.cache.get(afkId)
            const afkName   = afkMember?.displayName ?? 'AFK User'
            let reply = `> 🪼 | ${afkName} **${data.reason}**`
            if (elapsed) reply += `\n⏰ \`${elapsed}\``
            await message.reply({ content: reply, allowedMentions: { parse: [] } })
            break
        }
    }

    return { handleMessage }
}
