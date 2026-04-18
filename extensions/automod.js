import { PermissionFlagsBits } from 'discord.js'

export function registerAutomod(client, db, heart) {
    const automodSpam = new Map()

    setInterval(() => {
        const now = Date.now()
        for (const [k, arr] of automodSpam) {
            const fresh = arr.filter(t => now - t < 5000)
            if (!fresh.length) automodSpam.delete(k)
            else automodSpam.set(k, fresh)
        }
    }, 60_000).unref()

    async function runAutomod(message) {
        if (message.author.bot || !message.guild) return
        if (message.member?.permissions.has(PermissionFlagsBits.ModerateMembers)) return

        let settings = heart.automodCache.get(message.guild.id)
        if (settings === undefined) {
            settings = db.prepare('SELECT * FROM automod_settings WHERE guild_id=?').get(String(message.guild.id)) ?? false
            heart.automodCache.set(message.guild.id, settings)
        }
        if (!settings) return

        const key = `${message.guild.id}_${message.author.id}`
        const now = Date.now()

        if (settings.anti_spam) {
            let ts = automodSpam.get(key) ?? []
            ts = ts.filter(t => now - t < 5000)
            ts.push(now)
            automodSpam.set(key, ts)
            if (ts.length >= (settings.spam_threshold || 5)) {
                automodSpam.delete(key)
                try { await message.delete() } catch {}
                await message.channel.send({ content: `🛑 ${message.author}, you're sending messages too fast!` })
                    .then(m => setTimeout(() => m.delete().catch(() => {}), 5000))
                return
            }
        }

        if (settings.anti_caps && message.content.length > 10) {
            const ratio = [...message.content].filter(c => c >= 'A' && c <= 'Z').length / message.content.length
            if (ratio > 0.7) {
                try { await message.delete() } catch {}
                await message.channel.send({ content: `${message.author}, please don't use excessive caps!` })
                    .then(m => setTimeout(() => m.delete().catch(() => {}), 5000))
                return
            }
        }

        if (settings.anti_links) {
            const LINK_WHITELIST = /(?:cdn\.discordapp\.com|media\.discordapp\.net|discord\.gg|tenor\.com|giphy\.com)/i
            if (/https?:\/\/|www\.|\.com|\.net|\.org/i.test(message.content) && !LINK_WHITELIST.test(message.content)) {
                try { await message.delete() } catch {}
                await message.channel.send({ content: `${message.author}, links are not allowed!` })
                    .then(m => setTimeout(() => m.delete().catch(() => {}), 5000))
            }
        }
    }

    async function handleInteraction(interaction) {
        if (interaction.commandName !== 'automod') return false
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
            await interaction.reply({ content: '❌ Manage Server permission required.', flags: 64 })
            return true
        }
        const sub     = interaction.options.getSubcommand()
        const guildId = String(interaction.guild.id)
        const current = db.prepare('SELECT * FROM automod_settings WHERE guild_id=?').get(guildId)
            ?? { guild_id: guildId, anti_spam: 0, anti_caps: 0, anti_links: 0, max_mentions: 5, spam_threshold: 5 }

        if (sub === 'status') {
            const lines = [
                `**Anti-Spam:** ${current.anti_spam ? '✅' : '❌'} (threshold: ${current.spam_threshold})`,
                `**Anti-Caps:** ${current.anti_caps ? '✅' : '❌'}`,
                `**Anti-Links:** ${current.anti_links ? '✅' : '❌'}`,
            ]
            await interaction.reply({ content: `📋 **Automod Settings:**\n${lines.join('\n')}`, flags: 64 })
            return true
        }

        const field = { 'anti-spam': 'anti_spam', 'anti-caps': 'anti_caps', 'anti-links': 'anti_links' }[sub]
        if (field) {
            const enabled = interaction.options.getBoolean('enabled')
            current[field] = enabled ? 1 : 0
            db.prepare(`INSERT INTO automod_settings (guild_id, anti_spam, anti_caps, anti_links, max_mentions, spam_threshold)
                VALUES (?,?,?,?,?,?) ON CONFLICT(guild_id) DO UPDATE SET ${field}=excluded.${field}`)
                .run(guildId, current.anti_spam, current.anti_caps, current.anti_links, current.max_mentions, current.spam_threshold)
            heart.automodCache.set(interaction.guild.id, current)
            await interaction.reply({ content: `✅ **${sub}** ${enabled ? 'enabled' : 'disabled'}.`, flags: 64 })
            return true
        }
        return false
    }

    return { runAutomod, handleInteraction }
}
