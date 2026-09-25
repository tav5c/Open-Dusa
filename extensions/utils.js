import { MessageFlags } from 'discord.js'

export const MAX_SECONDS = 2419200
export const TIME_UNITS = { s: 1, m: 60, h: 3600, d: 86400 }

// Servers where bot output stays silent: paused via /ai-pause, or outside
// the configured guild scope. Null = fine. Reads the AI cog live so both
// listeners share one definition.
export function guildBlockedReason(client, guild) {
    if (!guild) return null
    const cog = client?.aiCog
    if (cog?.pausedGuilds?.has(guild.id)) return 'paused'
    if (cog?.allowedGuilds?.size && !cog.allowedGuilds.has(guild.id)) return 'inactive'
    return null
}

// Force reply-style responses on this interaction ephemeral (reply/edit/
// followUp/defer), merging with existing flags. For blocked servers:
// nothing the bot says there is publicly visible. Idempotent per
// interaction. `update` is excluded (button updates reject unknown fields).
export function forceEphemeral(interaction) {
    if (!interaction || interaction._forceEph) return
    interaction._forceEph = true
    for (const m of ['reply', 'editReply', 'followUp', 'deferReply']) {
        const orig = interaction[m]?.bind(interaction)
        if (!orig) continue
        interaction[m] = (opts, ...rest) => {
            if (typeof opts === 'string') opts = { content: opts }
            if (opts && typeof opts === 'object') {
                if (Array.isArray(opts.flags)) {
                    if (!opts.flags.includes(MessageFlags.Ephemeral))
                        opts.flags = [...opts.flags, MessageFlags.Ephemeral]
                } else opts.flags = (opts.flags ?? 0) | MessageFlags.Ephemeral
            }
            return orig(opts, ...rest)
        }
    }
}
export async function resolveTarget(ctx, args, fetchUser = false, allowSelfFallback = true) {
    const isMsg = ctx.content !== undefined
    if (!isMsg) return ctx.options?.getMember?.('user') || ctx.member

    if (args && args.length > 0) {
        const id = args[0].replace(/[<@!>]/g, '')
        if (id && /^\d{15,20}$/.test(id)) {
            let member = await ctx.guild.members.fetch(id).catch(() => null)
            if (member) return fetchUser ? member.user : member
            return await ctx.client.users.fetch(id).catch(() => null)
        }
    }
    const nonBot = ctx.mentions?.members?.filter((m) => m.id !== ctx.client.user.id).first()
    if (nonBot) return fetchUser ? nonBot.user : nonBot
    // No ID, no mention: only fall back to the caller when the caller opted
    // in. Destructive commands pass false — a bare `med,kick` must ask who,
    // not kick the moderator typing it (owner/admin bypasses in canModerate
    // would otherwise let a self-kick/self-mute straight through).
    if (!allowSelfFallback) return null
    return fetchUser ? ctx.author : ctx.member
}

export function parseTime(str) {
    const m = str?.match(/^(\d+)([smhd])$/)
    if (!m) return { delta: null, error: '❌ Invalid format. Use `10m`, `2h`, `1d`, max `28d`.' }
    const secs = parseInt(m[1]) * TIME_UNITS[m[2]]
    if (secs > MAX_SECONDS) return { delta: null, error: '❌ Max mute duration is `28d`.' }
    return { delta: secs * 1000, error: null }
}

export function formatDuration(ms) {
    const s = Math.floor(ms / 1000)
    if (s >= 2592000) return `${Math.floor(s / 2592000)}mo`
    if (s >= 604800) return `${Math.floor(s / 604800)}w`
    if (s >= 86400) return `${Math.floor(s / 86400)}d`
    if (s >= 3600) return `${Math.floor(s / 3600)}h`
    if (s >= 60) return `${Math.floor(s / 60)}m`
    return `${s}s`
}
