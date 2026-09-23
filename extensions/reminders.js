// extensions/reminders.js, persistent reminders that survive restarts.
//
// Reminders live in SQLite, not in setTimeout: a 20s poll tick fires anything
// due, and on boot anything that came due while the bot was offline fires
// immediately with a "sorry I'm late" note. Commands are registered on
// client.commands, so they work both as prefix commands (med, remind ...) and
// as AI-dispatched <<RUN_CMD: remind ...>> actions with zero extra wiring.
import { loadConfig } from './config.js'
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, EmbedBuilder } from 'discord.js'

const TICK_MS = 15_000
const MAX_PER_USER = 25
const MAX_TEXT = 300
const UNITS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }

// "1h30m", "45m", "2d12h" -> ms (null when nothing parseable)
export function parseDuration(str) {
    let ms = 0
    for (const [, n, u] of String(str ?? '').matchAll(/(\d+)\s*([smhdw])/gi))
        ms += Number(n) * UNITS[u.toLowerCase()]
    return ms > 0 ? ms : null
}

// Recurring specs: "every 1d" (interval) or "every friday 17:00" (weekly,
// HH:MM optional, UTC). Returns {spec, nextAt} or null. Intervals floor at
// 5 minutes (anti-spam); weekly needs a weekday name.
const WEEKDAYS = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 }
const MIN_RECUR_MS = 5 * 60_000
export function parseEvery(s) {
    const t = String(s ?? '')
        .trim()
        .toLowerCase()
    const iv = parseDuration(t)
    if (iv) {
        if (iv < MIN_RECUR_MS) return { error: 'shortest repeat is every 5 minutes' }
        return { spec: `every ${t}`, nextAt: Date.now() + iv }
    }
    const m = /^(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\s*(\d{1,2}):?(\d{2})?$/.exec(t)
    if (m) {
        const hh = Math.min(23, Number(m[2] ?? '9'))
        const mm = Math.min(59, Number(m[3] ?? '0'))
        const now = new Date()
        const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hh, mm))
        let delta = (WEEKDAYS[m[1]] - d.getUTCDay() + 7) % 7
        if (delta === 0 && d.getTime() <= Date.now()) delta = 7
        d.setUTCDate(d.getUTCDate() + delta)
        return {
            spec: `every ${m[1]} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`,
            nextAt: d.getTime(),
        }
    }
    return null
}

export function nextRecur(spec, from = Date.now()) {
    const t = String(spec ?? '').replace(/^every\s+/, '')
    const iv = parseDuration(t)
    if (iv && iv >= MIN_RECUR_MS) return from + iv
    const m = /^(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\s*(\d{1,2}):?(\d{2})?$/.exec(t)
    if (m) {
        const p = parseEvery(t)
        if (p?.nextAt && p.nextAt > from) return p.nextAt
        // Same weekday next week (parseEvery anchors on now, so recompute anyway).
        const hh = Math.min(23, Number(m[2] ?? '9'))
        const mm = Math.min(59, Number(m[3] ?? '0'))
        const base = new Date(from)
        const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), hh, mm))
        d.setUTCDate(d.getUTCDate() + 7)
        return d.getTime()
    }
    return null
}
// Accepts either a relative duration ("1h30m") or a single-token absolute
// date/datetime ("2026-01-12", "2026-01-12T18:00"). Returns ms-from-now, or
// null if unparseable or already in the past. Space-separated dates
// ("2026-01-12 18:00") must use T instead of a space, a bare space is
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
    // Stub-DB guard: on hosts where native bindings are blocked the loader
    // hands us a no-op handle whose .get() returns null. Every other consumer
    // tolerates that via try/catch — reminders must too, or the first
    // `remind` crashes the whole AI turn (TypeError on .n of null).
    if (!db || db._stub === true) {
        console.warn('[reminders] database unavailable, commands registered as offline')
        const offline = async (msg) =>
            msg.reply({
                content:
                    '⏰ reminders are offline right now (database unavailable), try again after a restart',
                allowedMentions: { parse: [] },
            })
        client.commands.set('remind', offline)
        client.commands.set('reminder', offline)
        client.commands.set('remindme', offline)
        client.commands.set('reminders', offline)
        client.commands.set('delreminder', offline)
        client.reminders = {
            create: () => ({ error: 'database unavailable' }),
            list: () => [],
            fire: async () => {},
        }
        return
    }
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
    // Recurring schedules: same table, recur holds the spec ("every 1d" or
    // "every friday 17:00"), runs counts firings. Migrates old tables.
    try {
        const cols = db
            .prepare('PRAGMA table_info(reminders)')
            .all()
            .map((c) => c.name)
        if (!cols.includes('recur')) db.prepare('ALTER TABLE reminders ADD COLUMN recur TEXT').run()
        if (!cols.includes('runs'))
            db.prepare('ALTER TABLE reminders ADD COLUMN runs INTEGER DEFAULT 0').run()
    } catch {}

    const MAX_RECUR_PER_USER = 10
    const MAX_RUNS = 1000 // forgotten schedules die on their own instead of spamming forever
    const q = {
        insert: db.prepare(
            'INSERT INTO reminders (user_id, guild_id, channel_id, message, due_at, created_at, recur, runs) VALUES (?, ?, ?, ?, ?, ?, ?, 0)',
        ),
        due: db.prepare('SELECT * FROM reminders WHERE due_at <= ? ORDER BY due_at LIMIT 10'),
        byUser: db.prepare('SELECT * FROM reminders WHERE user_id = ? ORDER BY due_at'),
        countUser: db.prepare('SELECT COUNT(*) AS n FROM reminders WHERE user_id = ?'),
        countRecur: db.prepare('SELECT COUNT(*) AS n FROM reminders WHERE user_id = ? AND recur IS NOT NULL'),
        byId: db.prepare('SELECT * FROM reminders WHERE id = ?'),
        del: db.prepare('DELETE FROM reminders WHERE id = ?'),
        resched: db.prepare('UPDATE reminders SET due_at = ?, runs = runs + 1 WHERE id = ?'),
    }

    async function fire(row) {
        // Original channel first; DM fallback covers deleted channels / lost perms.
        const late = Date.now() - row.due_at > 90_000 ? " *(sorry I'm late, I was offline ⏰)*" : ''
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
    // Recurring rows reschedule instead of dying (capped at MAX_RUNS).
    setInterval(async () => {
        for (const row of q.due.all(Date.now())) {
            if (row.recur) {
                const next = nextRecur(row.recur)
                const runs = (row.runs ?? 0) + 1
                if (!next || runs >= MAX_RUNS) {
                    q.del.run(row.id)
                } else {
                    q.resched.run(next, row.id)
                }
            } else {
                q.del.run(row.id)
            }
            await fire(row)
        }
    }, TICK_MS).unref()

    const create = ({ userId, guildId, channelId, message, dueAt, recur = null }) => {
        // Debug mode never touches the prod database — not even reminders.
        if (globalThis._medusaDebug === true) return { error: 'reminders are disabled in debug mode' }
        const existing = q.countUser.get(userId)?.n ?? 0
        if (existing >= MAX_PER_USER)
            return { error: `you already have ${MAX_PER_USER} reminders, clear some first` }
        if (recur) {
            const nRecur = q.countRecur.get(userId)?.n ?? 0
            if (nRecur >= MAX_RECUR_PER_USER)
                return {
                    error: `you already have ${MAX_RECUR_PER_USER} repeating schedules, clear some first`,
                }
        }
        const info = q.insert.run(
            userId,
            guildId ?? null,
            channelId,
            String(message).slice(0, MAX_TEXT),
            dueAt,
            Date.now(),
            recur,
        )
        return { id: info.lastInsertRowid, dueAt, recur }
    }
    client.reminders = { create, list: (uid) => q.byUser.all(uid), fire }

    const ownerId = loadConfig().ownerId

    client.commands.set('remind', async (msg, args) => {
        // Optional leading channel target: `remind #announcements 1h text`
        // (mention or ID). Must be a text channel the bot can see, else the
        // reminder stays in the origin channel. Fires there at due time.
        let targetChannelId = msg.channel.id
        if (/^<#\d{15,20}>$/.test(args[0] ?? '') || /^\d{15,20}$/.test(args[0] ?? '')) {
            const cid = (args[0] ?? '').replace(/\D/g, '')
            const chan = await msg.client.channels.fetch(cid).catch(() => null)
            if (chan?.isTextBased?.()) {
                targetChannelId = chan.id
                args = args.slice(1)
            }
        } else if (/^#([\p{L}\p{N}_-]+)$/u.test(args[0] ?? '') && msg.guild) {
            const want = args[0].slice(1).toLowerCase()
            const chan = msg.guild.channels.cache.find(
                (c) => c.name?.toLowerCase() === want && c.isTextBased?.(),
            )
            if (chan) {
                targetChannelId = chan.id
            }
            // Resolved or not, the token is consumed: an unknown #name falls
            // back to the origin channel instead of usage-erroring.
            args = args.slice(1)
        }
        // Optional repeat: `remind every 1d text` or `remind every friday 17:00 text`
        // (weekly time is UTC). Must come after channel parsing, before duration.
        let recurSpec = null
        let dueAt = null
        if ((args[0] ?? '').toLowerCase() === 'every') {
            // Try interval first (`every 1d`), then weekly (`every friday 17:00`).
            let parsed = parseEvery(args[1] ?? '')
            let consumed = 1
            if (!parsed || parsed.error) {
                const two = `${args[1] ?? ''} ${args[2] ?? ''}`.trim()
                const weekly = parseEvery(two)
                if (weekly && !weekly.error) {
                    parsed = weekly
                    consumed = 2
                }
            }
            if (!parsed) {
                return msg.reply({
                    content:
                        '⏰ Usage: `remind every 1d drink water` or `remind every friday 17:00 deploy` (weekly time is UTC, shortest repeat every 5m)',
                    allowedMentions: { parse: [] },
                })
            }
            if (parsed.error)
                return msg.reply({ content: `⏰ ${parsed.error}`, allowedMentions: { parse: [] } })
            recurSpec = parsed.spec
            dueAt = parsed.nextAt
            args = args.slice(1 + consumed)
        }
        const dur = dueAt ? dueAt - Date.now() : parseWhen(args[0])
        const text = args
            .slice(dueAt ? 0 : 1)
            .join(' ')
            .trim()
        if (!dur || !text)
            return msg.reply({
                content:
                    '⏰ Usage: `remind 1h30m take the pizza out` (units: s/m/h/d/w), `remind 2026-01-12T18:00 take the pizza out` for an exact date/time, `remind #announcements 1h meeting in 5` to fire in another channel, or `remind every 1d drink water` to repeat',
                allowedMentions: { parse: [] },
            })
        if (!recurSpec && dur > 365 * UNITS.d)
            return msg.reply({
                content: "⏰ That's more than a year out, pick something shorter.",
                allowedMentions: { parse: [] },
            })
        const res = create({
            userId: msg.author.id,
            guildId: msg.guild?.id,
            channelId: targetChannelId,
            message: text,
            dueAt: dueAt ?? Date.now() + dur,
            recur: recurSpec,
        })
        if (res.error) return msg.reply({ content: `⏰ ${res.error}`, allowedMentions: { parse: [] } })
        const where = targetChannelId !== msg.channel.id ? ` in <#${targetChannelId}>` : ''
        const rep = recurSpec ? ` repeats 🔁 \`${recurSpec}\`` : ''
        await msg.reply({
            content: `⏰ Got it, reminder **#${res.id}**${where}${rep} set for <t:${Math.floor(res.dueAt / 1000)}:R>: **${text.slice(0, 100)}**`,
            allowedMentions: { parse: [] },
        })
    })
    // Aliases, people (and the AI) reach for these names constantly.
    client.commands.set('reminder', client.commands.get('remind'))
    client.commands.set('remindme', client.commands.get('remind'))

    client.commands.set('reminders', async (msg) => {
        const rows = q.byUser.all(msg.author.id)
        if (!rows.length)
            return msg.reply({ content: '⏰ You have no pending reminders.', allowedMentions: { parse: [] } })
        const shown = rows.slice(0, 5)
        const embed = new EmbedBuilder()
            .setTitle('⏰ Your pending reminders')
            .setColor(0xef9f27)
            .setDescription(
                shown
                    .map(
                        (r) =>
                            `**#${r.id}**${r.recur ? ` 🔁 \`${r.recur}\`` : ''} — <t:${Math.floor(r.due_at / 1000)}:R> in <#${r.channel_id}>\n${r.message.slice(0, 120)}`,
                    )
                    .join('\n\n'),
            )
            .setFooter({ text: rows.length > 5 ? `showing 5 of ${rows.length}` : 'tap ✖ to cancel' })
        const row = new ActionRowBuilder().addComponents(
            ...shown.map((r) =>
                new ButtonBuilder()
                    .setCustomId(`rmd-del:${r.id}`)
                    .setLabel(`✖ #${r.id}`)
                    .setStyle(ButtonStyle.Danger),
            ),
        )
        const sent = await msg.reply({ embeds: [embed], components: [row], allowedMentions: { parse: [] } })
        const reply = sent?.message ?? sent
        if (!reply?.createMessageComponentCollector) return
        const col = reply.createMessageComponentCollector({
            componentType: ComponentType.Button,
            time: 60_000,
        })
        col.on('collect', async (i) => {
            try {
                if (i.user.id !== msg.author.id) {
                    await i
                        .reply({ content: 'Not yours — check your own reminders.', flags: 64 })
                        .catch(() => {})
                    return
                }
                const id = Number(String(i.customId ?? '').split(':')[1])
                const target = Number.isFinite(id) ? q.byId.get(id) : null
                if (!target || (target.user_id !== msg.author.id && msg.author.id !== ownerId)) {
                    await i.reply({ content: "⏰ That one's already gone.", flags: 64 }).catch(() => {})
                    return
                }
                q.del.run(target.id)
                await i
                    .update({
                        content: `⏰ Reminder **#${target.id}** cancelled.`,
                        embeds: [],
                        components: [],
                    })
                    .catch(() => {})
                col.stop()
            } catch (e) {
                console.error('[reminders] cancel button error:', e)
            }
        })
        col.on('end', async () => {
            try {
                await reply.edit({ components: [] }).catch(() => {})
            } catch {}
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

    // (Loader logs name+version uniformly; no self-log here to avoid doubles.)
}
