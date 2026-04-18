export const MAX_SECONDS = 2419200
export const TIME_UNITS  = { s: 1, m: 60, h: 3600, d: 86400 }
export async function resolveTarget(ctx, args, fetchUser = false) {
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
    const nonBot = ctx.mentions?.members?.filter(m => m.id !== ctx.client.user.id).first()
    if (nonBot) return fetchUser ? nonBot.user : nonBot
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
    if (s >= 604800)  return `${Math.floor(s / 604800)}w`
    if (s >= 86400)   return `${Math.floor(s / 86400)}d`
    if (s >= 3600)    return `${Math.floor(s / 3600)}h`
    if (s >= 60)      return `${Math.floor(s / 60)}m`
    return `${s}s`
}
