// extensions/reminders.js — persistent reminders that survive restarts.
//
// Reminders live in SQLite, not in setTimeout: a 20s poll tick fires anything
// due, and on boot anything that came due while the bot was offline fires
// immediately with a "sorry I'm late" note. Commands are registered on
// client.commands, so they work both as prefix commands (med, remind ...) and
// as AI-dispatched <<RUN_CMD: remind ...>> actions with zero extra wiring.
import { loadConfig } from './config.js'

const TICK_MS = 15_000
const MAX_PER_USER = 25
const MAX_TEXT = 300
const UNITS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }

// "1h30m", "45m", "2d12h" → ms (null when nothing parseable)
export function parseDuration(str) {
    let ms = 0
    for (const [, n, u] of String(str ?? '').matchAll(/(\d+)\s*([smhdw])/gi))
        ms += Number(n) * UNITS[u.toLowerCase()]
    return ms > 0 ? ms : null
}

// Accepts either a relative duration ("1h30m") or a single-token absolute
// date/datetime ("2026-01-12", "2026-01-12T18:00"). Returns ms-from-now, or
// null if unparseable or already in the past. Space-separated dates
// ("2026-01-12 18:00") must use T instead of a space — a bare space is
// ambiguous with "<duration> <message>" in the plain-text command syntax.
export function parseWhen(str) {
    const rel = parseDuration(str)
    if (rel) return rel
    const s = String(str ?? '').trim()
    if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/.test(s)) return null
    const d = new Date(s)
    if (isNaN(d.getTime())) return null
    const delta = d.getTime() - Date.now()
    return delta > 0 ? delta : null
}

export const manifest = {
    name: 'reminders',
    version: '1.0.0',
    author: 'Open-Dusa',
    description: 'Persistent, restart-safe reminders (prefix + AI RUN_CMD)',
    apiVersion: 1,
    slashCommands: [],
    permissions: [],
    dependencies: [],
}

export async function init(client, db) {
    db.prepare(
        `CREATE TABLE IF NOT EXISTS reminders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            guild_id TEXT,
            channel_id TEXT NOT NULL,
            message TEXT NOT NULL,
            due_at INTEGER NOT NULL,
            created_at INTEGER NOT NULL
        )`,
    ).run()
    db.prepare('CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders (due_at)').run()

    const q = {
        insert: db.prepare(
            'INSERT INTO reminders (user_id, guild_id, channel_id, message, due_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        ),
        due: db.prepare('SELECT * FROM reminders WHERE due_at <= ? ORDER BY due_at LIMIT 10'),
        byUser: db.prepare('SELECT * FROM reminders WHERE user_id = ? ORDER BY due_at'),
        countUser: db.prepare('SELECT COUNT(*) AS n FROM reminders WHERE user_id = ?'),
        byId: db.prepare('SELECT * FROM reminders WHERE id = ?'),
        del: db.prepare('DELETE FROM reminders WHERE id = ?'),
    }

    async function fire(row) {
        // Original channel first; DM fallback covers deleted channels / lost perms.
        const late = Date.now() - row.due_at > 90_000 ? " *(sorry I'm late — I was offline ⏰)*" : ''
        const payload = {
            content: `⏰ <@${row.user_id}> reminder: **${row.message}**${late}`,
            allowedMentions: { users: [row.user_id] },
        }
        const chan = await client.channels.fetch(row.channel_id).catch(() => null)
        if (chan?.isTextBased()) {
            const sent = await chan.send(payload).catch(() => null)
            if (sent) return
        }
        const user = await client.users.fetch(row.user_id).catch(() => null)
        await user?.send(payload).catch(() => {})
    }

    // unref'd so a pending tick never keeps a dying process alive.
    // Delete-before-send: a crash mid-delivery beats a double-fire loop.
    setInterval(async () => {
        for (const row of q.due.all(Date.now())) {
            q.del.run(row.id)
            await fire(row)
        }
    }, TICK_MS).unref()

    const create = ({ userId, guildId, channelId, message, dueAt }) => {
        if (q.countUser.get(userId).n >= MAX_PER_USER)
            return { error: `you already have ${MAX_PER_USER} reminders — clear some first` }
        const info = q.insert.run(
            userId,
            guildId ?? null,
            channelId,
            String(message).slice(0, MAX_TEXT),
            dueAt,
            Date.now(),
        )
        return { id: info.lastInsertRowid, dueAt }
    }
    client.reminders = { create, list: (uid) => q.byUser.all(uid), fire }

    const ownerId = loadConfig().ownerId

    client.commands.set('remind', async (msg, args) => {
        const dur = parseWhen(args[0])
        const text = args.slice(1).join(' ').trim()
        if (!dur || !text)
            return msg.reply({
                content:
                    '⏰ Usage: `remind 1h30m take the pizza out` (units: s/m/h/d/w) or `remind 2026-01-12T18:00 take the pizza out` for an exact date/time',
                allowedMentions: { parse: [] },
            })
        if (dur > 365 * UNITS.d)
            return msg.reply({
                content: "⏰ That's more than a year out — pick something shorter.",
                allowedMentions: { parse: [] },
            })
        const res = create({
            userId: msg.author.id,
            guildId: msg.guild?.id,
            channelId: msg.channel.id,
            message: text,
            dueAt: Date.now() + dur,
        })
        if (res.error) return msg.reply({ content: `⏰ ${res.error}`, allowedMentions: { parse: [] } })
        await msg.reply({
            content: `⏰ Got it — reminder **#${res.id}** set for <t:${Math.floor(res.dueAt / 1000)}:R>: **${text.slice(0, 100)}**`,
            allowedMentions: { parse: [] },
        })
    })
    // Aliases — people (and the AI) reach for these names constantly.
    client.commands.set('reminder', client.commands.get('remind'))
    client.commands.set('remindme', client.commands.get('remind'))

    client.commands.set('reminders', async (msg) => {
        const rows = q.byUser.all(msg.author.id)
        if (!rows.length)
            return msg.reply({ content: '⏰ You have no pending reminders.', allowedMentions: { parse: [] } })
        const lines = rows
            .slice(0, 15)
            .map((r) => `**#${r.id}** — <t:${Math.floor(r.due_at / 1000)}:R> — ${r.message.slice(0, 80)}`)
        await msg.reply({
            content: `⏰ Your reminders:\n${lines.join('\n')}`,
            allowedMentions: { parse: [] },
        })
    })

    client.commands.set('delreminder', async (msg, args) => {
        const row = /^\d+$/.test(args[0] ?? '') ? q.byId.get(Number(args[0])) : null
        // Only the reminder's owner (or the bot owner) may cancel it
        if (!row || (row.user_id !== msg.author.id && msg.author.id !== ownerId))
            return msg.reply({
                content: "⏰ No reminder with that ID (or it isn't yours).",
                allowedMentions: { parse: [] },
            })
        q.del.run(row.id)
        await msg.reply({ content: `⏰ Reminder **#${row.id}** cancelled.`, allowedMentions: { parse: [] } })
    })

    console.log(`[${manifest.name}] Loaded v${manifest.version}`)
}
