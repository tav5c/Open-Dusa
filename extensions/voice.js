// Voice presence: join/leave voice channels on request. Presence only — no audio
// playback. Invoked by prefix (`med,joinvc`) or by the agent via
// <<RUN_CMD: joinvc <channelId|name>>> / <<RUN_CMD: leavevc>>. Permission-gated
// inside the handlers (mods / Manage Channels), since these aren't in the
// agent's MOD_CMDS map.
import { PermissionFlagsBits } from 'discord.js'
import { getVoiceConnection, joinVoiceChannel } from '@discordjs/voice'

function canSummon(member, ownerId) {
    if (!member) return false
    if (String(member.id ?? member.user?.id) === String(ownerId)) return true
    const p = member.permissions
    return (
        p?.has(PermissionFlagsBits.ManageChannels) || p?.has(PermissionFlagsBits.ModerateMembers)
    )
}

export function registerVoice(client, ownerId) {
    const joinCmd = async (ctx, args) => {
        const reply = (data) => ctx.reply(data).catch(() => {})
        if (!ctx.guild) return reply({ content: '❌ Voice only works in a server.' })
        const member = ctx.member
        if (!canSummon(member, ownerId))
            return reply({ content: '🔑 You need **Manage Channels** (or mod) to move me around.' })
        const raw = args[0]?.replace(/[<#>]/g, '') ?? ''
        const byId = /^\d{15,20}$/.test(raw) ? ctx.guild.channels.cache.get(raw) : null
        const vcById = byId?.isVoiceBased?.() ? byId : null
        const vcByName =
            !vcById && raw
                ? ctx.guild.channels.cache.find(
                      (c) => c.isVoiceBased?.() && c.name?.toLowerCase() === raw.toLowerCase(),
                  )
                : null
        const vc = vcById ?? vcByName ?? member?.voice?.channel ?? null
        if (!vc || !vc.isVoiceBased?.())
            return reply({
                content: "❌ Which voice channel? Give me an ID or name — or join one yourself and I'll follow.",
            })
        const me = ctx.guild.members.me
        if (!vc.permissionsFor(me)?.has(PermissionFlagsBits.Connect))
            return reply({ content: `❌ I can't connect to **${vc.name}**. Check my permissions.` })
        try {
            // Destroy any stale connection first: repeated joinvc calls must move
            // the single guild connection, never stack half-dead voice websockets.
            getVoiceConnection(ctx.guild.id)?.destroy()
            joinVoiceChannel({
                channelId: vc.id,
                guildId: ctx.guild.id,
                adapterCreator: ctx.guild.voiceAdapterCreator,
                // Presence only: deafened + muted so the channel never shows her
                // as listening, and no audio is sent either.
                selfDeaf: true,
                selfMute: true,
            })
            await reply({ content: `🔊 Joined **${vc.name}**.` })
        } catch (e) {
            await reply({ content: `❌ Couldn't join: ${e.message}` })
        }
    }

    const leaveCmd = async (ctx) => {
        const reply = (data) => ctx.reply(data).catch(() => {})
        if (!ctx.guild) return reply({ content: '❌ Server only.' })
        // Same gate as join: anyone could otherwise yank her out of a mod's session.
        if (!canSummon(ctx.member, ownerId))
            return reply({ content: '🔑 You need **Manage Channels** (or mod) to move me around.' })
        const conn = getVoiceConnection(ctx.guild.id)
        if (!conn) return reply({ content: "❌ I'm not in a voice channel here." })
        try {
            conn.destroy()
            await reply({ content: '👋 Left voice.' })
        } catch (e) {
            await reply({ content: `❌ Couldn't leave: ${e.message}` })
        }
    }

    client.commands.set('joinvc', joinCmd)
    client.commands.set('leavevc', leaveCmd)
    client.commands.set('vc', async (ctx) => {
        const conn = ctx.guild ? getVoiceConnection(ctx.guild.id) : null
        const chanId = conn?.joinConfig?.channelId
        const chan = chanId ? ctx.guild.channels.cache.get(chanId) : null
        await ctx
            .reply({ content: chan ? `🔊 I'm in **${chan.name}**.` : "🔇 I'm not in voice here." })
            .catch(() => {})
    })
}
