// Persistence layer: pooled SQLite handles, per-user agentic memory + lore,
// and the ghost-user list. One AIMemoryManager per memory scope (global/isolated).
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { loadPerformance } from '../performance.js'
import { GHOST_FILE } from './constants.js'
import { containsDisallowedHate } from './safety.js'

const PERF = loadPerformance()

class DBPool {
    constructor() {
        this._pool = new Map()
    }
    get(path) {
        if (!globalThis._sqlite3) {
            return {
                prepare: () => ({ run: () => {}, get: () => null, all: () => [] }),
                exec: () => {},
                pragma: () => {},
                close: () => {},
                _stub: true,
            }
        }
        if (!this._pool.has(path)) {
            mkdirSync(dirname(path) || '.', { recursive: true })
            const conn = globalThis._openDb
                ? globalThis._openDb(path)
                : new globalThis._sqlite3.default(path)
            // EXCLUSIVE locking avoids the need for a -shm file in WAL mode (fixes SQLITE_IOERR_SHMSIZE on cheap hosts)
            conn.pragma('locking_mode = EXCLUSIVE')
            try {
                conn.pragma('journal_mode = WAL')
            } catch (e) {
                console.warn(`[DB] WAL mode fallback: ${e.message}`)
            }
            conn.pragma('synchronous = NORMAL')
            conn.pragma('temp_store = MEMORY')
            conn.pragma(`journal_size_limit = ${PERF.sqlite.journalSizeLimit}`)
            try {
                conn.pragma(`mmap_size = ${PERF.sqlite.mmapSizeBytes}`)
            } catch {}
            conn.pragma(`cache_size = -${PERF.sqlite.cacheSizeKB}`)
            conn.pragma(`wal_autocheckpoint = ${PERF.sqlite.walAutocheckpoint}`)
            conn.pragma('busy_timeout = 5000')

            // TRUNCATE truncates the WAL file to zero bytes, freeing disk space (fixes SQLITE_FULL on Pterodactyl)
            conn._checkpointInterval = setInterval(() => {
                try {
                    if (conn.open) conn.pragma('wal_checkpoint(TRUNCATE)')
                    else clearInterval(conn._checkpointInterval)
                } catch {}
            }, 300_000).unref()

            this._pool.set(path, conn)
        }
        return this._pool.get(path)
    }
    closeAll() {
        for (const [, c] of this._pool) {
            try {
                if (c._checkpointInterval) clearInterval(c._checkpointInterval)
                c.close()
            } catch {}
        }
        this._pool.clear()
    }
}
const dbPool = new DBPool()

// Memory manager
class AIMemoryManager {
    _writeQueue = []
    _flushTimer = null

    constructor(guildId = null, guildName = null) {
        ;(globalThis._aiMemManagers ??= new Set()).add(this)
        let base = 'data/ai'
        if (guildId) {
            const safeName = (guildName || guildId).replace(/[/\\]/g, '_')
            let folder = `${safeName} - ${guildId}`
            // if this guild was isolated before (maybe under an old name), pick
            // its old folder back up so re-isolating resumes the same db
            this.resumed = false
            try {
                const prev = readdirSync('data/ai', { withFileTypes: true }).find(
                    (d) => d.isDirectory() && d.name.endsWith(` - ${guildId}`),
                )
                if (prev) {
                    folder = prev.name
                    this.resumed = true
                }
            } catch {}
            base = join('data/ai', folder)
        }
        this._guildId = guildId
        mkdirSync(base, { recursive: true })
        this.db = dbPool.get(join(base, 'memory.db'))
        this._initSchema()
        this._purgeUnsafeMemory()
        this._interestsThrottle = new Map()
        this._personalityThrottle = new Map()
        // Auto-vacuum: each DB compacts on its own schedule so no two files block each
        // other. The boot delay keeps first-message latency clean; runtime-created
        // isolated DBs pick this up automatically since it lives in the constructor.
        setTimeout(() => this.vacuum(), 30_000).unref()
        setInterval(() => this.vacuum(), (24 + Math.random() * 2) * 3600_000).unref()
    }

    _deferWrite(fn) {
        this._writeQueue.push(fn)
        if (!this._flushTimer) {
            this._flushTimer = setTimeout(() => {
                const batch = this._writeQueue
                this._writeQueue = []
                this._flushTimer = null
                for (const f of batch) f()
            }, 150)
        }
    }

    _initSchema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS users (
                user_id TEXT PRIMARY KEY, username TEXT, display_name TEXT, avatar_url TEXT,
                conversation_count INTEGER DEFAULT 0,
                last_interaction DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS conversations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT, channel_id TEXT,
                message_content TEXT, ai_response TEXT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS interests (
                user_id TEXT, topic TEXT, frequency INTEGER DEFAULT 1,
                last_mentioned DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, topic)
            );
            CREATE TABLE IF NOT EXISTS personality (
                user_id TEXT PRIMARY KEY, traits TEXT, preferences TEXT,
                communication_style TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS relationships (
                user_id TEXT, related_user_id TEXT, relationship_type TEXT,
                strength INTEGER DEFAULT 1, last_interaction DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, related_user_id)
            );
            CREATE TABLE IF NOT EXISTS user_aliases (
                user_id TEXT, alias TEXT, set_by_user_id TEXT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, alias)
            );
            CREATE TABLE IF NOT EXISTS server_data (
                guild_id TEXT PRIMARY KEY, guild_name TEXT, owner_id TEXT,
                member_count INTEGER, last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id);
            CREATE INDEX IF NOT EXISTS idx_conv_time ON conversations(timestamp DESC);
            CREATE INDEX IF NOT EXISTS idx_interests_user ON interests(user_id);
            CREATE INDEX IF NOT EXISTS idx_rel_user ON relationships(user_id);
            CREATE TABLE IF NOT EXISTS server_lore (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                fact TEXT NOT NULL,
                source TEXT DEFAULT 'auto',
                frequency INTEGER DEFAULT 1,
                last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_lore_freq ON server_lore(frequency DESC);
            CREATE TABLE IF NOT EXISTS user_summaries (
                user_id TEXT PRIMARY KEY, summary TEXT,
                covered INTEGER DEFAULT 0, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `)

        // Pre-prepare frequently-used statements to avoid re-parsing SQL on every call
        if (!this.db._stub) {
            this._stmts = {
                updateUser: this.db.prepare(`
                    INSERT INTO users (user_id, username, display_name, conversation_count, last_interaction, updated_at)
                    VALUES (?,?,?,COALESCE((SELECT conversation_count FROM users WHERE user_id=?),0)+1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
                    ON CONFLICT(user_id) DO UPDATE SET
                        username=excluded.username, display_name=excluded.display_name,
                        conversation_count=conversation_count+1,
                        last_interaction=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
                `),
                addConversation: this.db.prepare(
                    'INSERT INTO conversations (user_id, channel_id, message_content, ai_response) VALUES (?,?,?,?)',
                ),
                upsertInterest: this.db.prepare(`
                    INSERT INTO interests (user_id, topic, frequency, last_mentioned)
                    VALUES (?,?,COALESCE((SELECT frequency FROM interests WHERE user_id=? AND topic=?),0)+1,CURRENT_TIMESTAMP)
                    ON CONFLICT(user_id, topic) DO UPDATE SET frequency=frequency+1, last_mentioned=CURRENT_TIMESTAMP
                `),
                upsertPersonality: this.db.prepare(`
                    INSERT INTO personality (user_id, traits, updated_at) VALUES (?,?,CURRENT_TIMESTAMP)
                    ON CONFLICT(user_id) DO UPDATE SET traits=excluded.traits, updated_at=CURRENT_TIMESTAMP
                `),
                upsertRelationship: this.db.prepare(`
                    INSERT INTO relationships (user_id, related_user_id, relationship_type, strength, last_interaction)
                    VALUES (?,?,'interaction',COALESCE((SELECT strength FROM relationships WHERE user_id=? AND related_user_id=?),0)+1,CURRENT_TIMESTAMP)
                    ON CONFLICT(user_id, related_user_id) DO UPDATE SET strength=strength+1, last_interaction=CURRENT_TIMESTAMP
                `),
                getUser: this.db.prepare('SELECT * FROM users WHERE user_id=?'),
                getHistory: this.db.prepare(
                    'SELECT message_content, ai_response, timestamp FROM conversations WHERE user_id=? ORDER BY timestamp DESC LIMIT ?',
                ),
                getChannelCtx: this.db.prepare(
                    'SELECT user_id, message_content, timestamp FROM conversations WHERE channel_id=? AND user_id!=? ORDER BY timestamp DESC LIMIT ?',
                ),
                getInterests: this.db.prepare(
                    'SELECT topic, frequency, last_mentioned FROM interests WHERE user_id=? ORDER BY frequency DESC, last_mentioned DESC LIMIT ?',
                ),
                getPersonality: this.db.prepare('SELECT * FROM personality WHERE user_id=?'),
                getRelationships: this.db.prepare(
                    'SELECT related_user_id, strength FROM relationships WHERE user_id=? ORDER BY strength DESC LIMIT 3',
                ),
            }
        }
    }


    _purgeUnsafeMemory() {
        if (this.db._stub) return
        try {
            const tx = this.db.transaction(() => {
                for (const row of this.db.prepare('SELECT id, message_content, ai_response FROM conversations').iterate())
                    if (containsDisallowedHate(row.message_content) || containsDisallowedHate(row.ai_response))
                        this.db.prepare('DELETE FROM conversations WHERE id=?').run(row.id)
                for (const row of this.db.prepare('SELECT id, fact FROM server_lore').iterate())
                    if (containsDisallowedHate(row.fact)) this.db.prepare('DELETE FROM server_lore WHERE id=?').run(row.id)
                for (const row of this.db.prepare('SELECT user_id, traits, preferences, communication_style FROM personality').iterate())
                    if (containsDisallowedHate([row.traits, row.preferences, row.communication_style].join(' ')))
                        this.db.prepare('DELETE FROM personality WHERE user_id=?').run(row.user_id)
            })
            tx()
        } catch {}
    }

    updateUser(userId, username, displayName) {
        // Execute immediately to prevent read-after-write race conditions for new users
        try {
            if (this._stmts) this._stmts.updateUser.run(userId, username, displayName, userId)
            else
                this.db
                    .prepare(
                        `
                INSERT INTO users (user_id, username, display_name, conversation_count, last_interaction, updated_at)
                VALUES (?,?,?,COALESCE((SELECT conversation_count FROM users WHERE user_id=?),0)+1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
                ON CONFLICT(user_id) DO UPDATE SET
                    username=excluded.username, display_name=excluded.display_name,
                    conversation_count=conversation_count+1,
                    last_interaction=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
            `,
                    )
                    .run(userId, username, displayName, userId)
        } catch (e) {
            console.error('[DB] updateUser error:', e)
        }
    }

    getUser(userId) {
        return (
            (this._stmts
                ? this._stmts.getUser.get(userId)
                : this.db.prepare('SELECT * FROM users WHERE user_id=?').get(userId)) ?? null
        )
    }

    addConversation(userId, channelId, msgContent, aiResponse) {
        if (containsDisallowedHate(msgContent) || containsDisallowedHate(aiResponse)) return false
        const msg = (msgContent ?? '').slice(0, 1000)
        const res = (aiResponse ?? '').slice(0, 2000)
        this._deferWrite(() => {
            if (this._stmts) this._stmts.addConversation.run(userId, channelId, msg, res)
            else
                this.db
                    .prepare(
                        'INSERT INTO conversations (user_id, channel_id, message_content, ai_response) VALUES (?,?,?,?)',
                    )
                    .run(userId, channelId, msg, res)
        })
    }

    getHistory(userId, limit = 10) {
        return this._stmts
            ? this._stmts.getHistory.all(userId, limit)
            : this.db
                  .prepare(
                      'SELECT message_content, ai_response, timestamp FROM conversations WHERE user_id=? ORDER BY timestamp DESC LIMIT ?',
                  )
                  .all(userId, limit)
    }

    getChannelContext(channelId, excludeUserId, limit = 5) {
        return this._stmts
            ? this._stmts.getChannelCtx.all(channelId, excludeUserId, limit)
            : this.db
                  .prepare(
                      'SELECT user_id, message_content, timestamp FROM conversations WHERE channel_id=? AND user_id!=? ORDER BY timestamp DESC LIMIT ?',
                  )
                  .all(channelId, excludeUserId, limit)
    }

    getSummary(userId) {
        try {
            return this.db.prepare('SELECT summary FROM user_summaries WHERE user_id=?').get(userId)?.summary ?? null
        } catch {
            return null
        }
    }

    usersNeedingSummary(keep = 60, max = 4) {
        // Only users whose backlog clearly outgrew the keep window, the margin avoids churn
        return this.db
            .prepare(
                'SELECT user_id, COUNT(*) AS backlog FROM conversations GROUP BY user_id HAVING backlog > ? LIMIT ?',
            )
            .all(keep + 25, max)
    }

    oldConversations(userId, keep = 60) {
        return this.db
            .prepare(
                'SELECT id, message_content, ai_response FROM conversations WHERE user_id=? ORDER BY timestamp DESC LIMIT -1 OFFSET ?',
            )
            .all(userId, keep)
    }

    saveSummaryAndPrune(userId, summary, ids) {
        if (containsDisallowedHate(summary)) return false
        try {
            const tx = this.db.transaction(() => {
                this.db
                    .prepare(
                        `INSERT INTO user_summaries (user_id, summary, covered, updated_at)
                        VALUES (?,?,?,CURRENT_TIMESTAMP)
                        ON CONFLICT(user_id) DO UPDATE SET summary=excluded.summary,
                            covered=covered+excluded.covered, updated_at=CURRENT_TIMESTAMP`,
                    )
                    .run(userId, String(summary).slice(0, 1500), ids.length)
                const del = this.db.prepare('DELETE FROM conversations WHERE id=?')
                for (const id of ids) del.run(id)
            })
            tx()
            return true
        } catch (e) {
            console.error('[DB] summary prune error:', e)
            return false
        }
    }

    updateInterests(userId, messageContent) {
        if (containsDisallowedHate(messageContent)) return
        if (messageContent.split(' ').length < 5) return
        const now = Date.now()
        const last = this._interestsThrottle.get(userId) ?? 0
        if (now - last < 60_000) return
        this._interestsThrottle.set(userId, now)
        if (this._interestsThrottle.size > 2000) {
            for (const [k, v] of this._interestsThrottle)
                if (now - v > 120_000) this._interestsThrottle.delete(k)
        }
        const stop = new Set([
            'that',
            'this',
            'with',
            'have',
            'they',
            'will',
            'been',
            'from',
            'were',
            'said',
            'each',
            'what',
            'just',
            'like',
            'more',
            'about',
            'time',
            'very',
            'when',
            'come',
            'could',
            'know',
            'into',
            'over',
            'think',
            'also',
            'back',
            'after',
            'first',
            'well',
            'good',
            'where',
            'much',
            'some',
            'only',
            'make',
            'work',
            'still',
            'should',
            'your',
            'want',
            'because',
            'through',
            'being',
            'before',
            'here',
            'then',
            'than',
            'any',
            'may',
            'say',
            'use',
            'all',
            'there',
            'which',
            'their',
            'has',
            'had',
            'two',
            'go',
            'way',
            'user',
            'replying',
            'message',
            'channel',
            'activity',
            'recent',
            'server',
            'context',
            'said',
            'content',
            'system',
            'replyed',
            'replied',
            'response',
        ])
        const kw = (messageContent.toLowerCase().match(/\b[a-zA-Z]{4,}\b/g) ?? [])
            .filter((w) => !stop.has(w))
            .slice(0, 3)
        if (!kw.length) return
        this._deferWrite(() => {
            const upsert =
                this._stmts?.upsertInterest ??
                this.db.prepare(`
                INSERT INTO interests (user_id, topic, frequency, last_mentioned)
                VALUES (?,?,COALESCE((SELECT frequency FROM interests WHERE user_id=? AND topic=?),0)+1,CURRENT_TIMESTAMP)
                ON CONFLICT(user_id, topic) DO UPDATE SET frequency=frequency+1, last_mentioned=CURRENT_TIMESTAMP
            `)
            for (const topic of kw) upsert.run(userId, topic, userId, topic)
        })
    }

    getInterests(userId, limit = 10) {
        return this._stmts
            ? this._stmts.getInterests.all(userId, limit)
            : this.db
                  .prepare(
                      'SELECT topic, frequency, last_mentioned FROM interests WHERE user_id=? ORDER BY frequency DESC, last_mentioned DESC LIMIT ?',
                  )
                  .all(userId, limit)
    }

    getPersonality(userId) {
        return (
            (this._stmts
                ? this._stmts.getPersonality.get(userId)
                : this.db.prepare('SELECT * FROM personality WHERE user_id=?').get(userId)) ?? null
        )
    }

    analyzePersonality(userId, messageContent) {
        if (containsDisallowedHate(messageContent)) return
        const now = Date.now()
        const last = this._personalityThrottle.get(userId) ?? 0
        if (now - last < 300_000) return
        this._personalityThrottle.set(userId, now)
        if (this._personalityThrottle.size > 1000) {
            for (const [k, v] of this._personalityThrottle)
                if (now - v > 600_000) this._personalityThrottle.delete(k)
        }
        const lower = messageContent.toLowerCase()
        const patterns = {
            direct: ['just', 'simply', 'exactly', 'straight up'],
            analytical: ['because', 'therefore', 'analyze', 'consider'],
            casual: ['lol', 'lmao', 'bruh', 'dude', 'nah', 'yeah', 'tbh'],
            formal: ['please', 'thank you', 'would you kindly', 'appreciate'],
            emotional: ['feel', 'love', 'hate', 'excited', 'frustrated'],
            technical: ['function', 'algorithm', 'database', 'api', 'debug'],
            creative: ['imagine', 'create', 'design', 'art', 'music'],
            helpful: ['help', 'assist', 'support', 'guide', 'teach'],
        }
        const detected = Object.entries(patterns)
            .filter(([, kw]) => kw.filter((w) => lower.includes(w)).length >= 2)
            .map(([trait]) => trait)
        if (!detected.length) return
        const existing = this.getPersonality(userId)
        const traitMap = {}
        if (existing?.traits)
            for (const t of existing.traits.split(', ')) traitMap[t] = (traitMap[t] ?? 0) + 1
        for (const t of detected) traitMap[t] = (traitMap[t] ?? 0) + 2
        const traits = Object.entries(traitMap)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([t]) => t)
            .join(', ')
        this._deferWrite(() => {
            const stmt =
                this._stmts?.upsertPersonality ??
                this.db.prepare(`
                INSERT INTO personality (user_id, traits, updated_at) VALUES (?,?,CURRENT_TIMESTAMP)
                ON CONFLICT(user_id) DO UPDATE SET traits=excluded.traits, updated_at=CURRENT_TIMESTAMP
            `)
            stmt.run(userId, traits)
        })
    }

    setAlias(userId, alias, setBy) {
        this.db
            .prepare('INSERT OR REPLACE INTO user_aliases (user_id, alias, set_by_user_id) VALUES (?,?,?)')
            .run(userId, alias, setBy)
    }

    updateRelationship(userId, relatedId) {
        this._deferWrite(() => {
            const stmt =
                this._stmts?.upsertRelationship ??
                this.db.prepare(`
                INSERT INTO relationships (user_id, related_user_id, relationship_type, strength, last_interaction)
                VALUES (?,?,'interaction',COALESCE((SELECT strength FROM relationships WHERE user_id=? AND related_user_id=?),0)+1,CURRENT_TIMESTAMP)
                ON CONFLICT(user_id, related_user_id) DO UPDATE SET strength=strength+1, last_interaction=CURRENT_TIMESTAMP
            `)
            stmt.run(userId, relatedId, userId, relatedId)
        })
    }

    buildContext(userId, channelId = null, ghostedIds = []) {
        const parts = []
        const user = this.getUser(userId)
        if (user) {
            const level =
                user.conversation_count > 50 ? 'active' : user.conversation_count > 10 ? 'regular' : 'new'
            parts.push(
                `User: ${user.display_name || user.username} (${level} - ${user.conversation_count} convos)`,
            )
        }
        const personality = this.getPersonality(userId)
        if (personality?.traits) parts.push(`Personality: ${personality.traits}`)

        const summary = this.getSummary(userId)
        if (summary) parts.push(`Long-term memory: ${summary}`)

        const interests = this.getInterests(userId, 10)
        if (interests.length) {
            const top = interests
                .slice(0, 5)
                .map((r) => `${r.topic}(${r.frequency})`)
                .join(', ')
            parts.push(`Key interests: ${top}`)
        }
        const history = this.getHistory(userId, 8)
        if (history.length) {
            parts.push('Recent topics:')
            history.forEach((r, i) => {
                const msg =
                    r.message_content.length > 60 ? r.message_content.slice(0, 60) + '...' : r.message_content
                parts.push(`  ${i + 1}. ${msg}`)
            })
        }

        // Relationships, who this user talks to most
        try {
            const rels = (
                this._stmts?.getRelationships ??
                this.db.prepare(
                    'SELECT related_user_id, strength FROM relationships WHERE user_id=? ORDER BY strength DESC LIMIT 3',
                )
            ).all(userId)
            if (rels.length) {
                const relStrs = rels
                    .map((r) => {
                        const u = this.getUser(r.related_user_id)
                        return `${u?.display_name ?? u?.username ?? r.related_user_id}(×${r.strength})`
                    })
                    .join(', ')
                parts.push(
                    `Relationship Graph (Top Friends): ${relStrs}. (Feel free to playfully mention or tease them about these users if appropriate!)`,
                )
            }
        } catch {}

        // Cross-session callback
        try {
            if (Math.random() < 0.15) {
                const old = this.db
                    .prepare(
                        `SELECT message_content FROM conversations WHERE user_id=? AND timestamp < datetime('now', '-3 days') AND length(message_content) > 20 ORDER BY RANDOM() LIMIT 1`,
                    )
                    .get(userId)
                if (old?.message_content) {
                    parts.push(`Old topic worth remembering: "${old.message_content.slice(0, 80)}"`)
                }
            }
        } catch {}

        // Server lore, cultural context
        const lore = this.getLore(8)
        if (lore.length) {
            parts.push(`Server culture/lore: ${lore.map((l) => l.fact).join(' | ')}`)
        }
        // Only fall back to DB channel context when the passive buffer is too thin.
        const passiveCount = globalThis._aiPassiveBuf?.get?.(channelId)?.length ?? 0
        if (channelId && passiveCount < 3) {
            const chCtx = this.getChannelContext(channelId, userId, 8)
            if (chCtx.length) {
                const filtered = ghostedIds.length
                    ? chCtx.filter((r) => !ghostedIds.includes(r.user_id))
                    : chCtx
                if (filtered.length) {
                    parts.push('Recent channel activity (others discussing):')
                    for (const r of filtered) {
                        const u = this.getUser(r.user_id)
                        const name = u?.display_name || u?.username || `User`
                        parts.push(`  ${name} (<@${r.user_id}>): ${r.message_content.slice(0, 80)}`)
                    }
                }
            }
        }
        return parts.join('\n')
    }

    vacuum() {
        // Deleted rows only mark pages free, VACUUM is what actually shrinks the file
        if (this.db._stub) return false
        try {
            this.db.pragma('wal_checkpoint(TRUNCATE)')
            this.db.exec('VACUUM')
            return true
        } catch (e) {
            console.error('[DB] vacuum error:', e.message)
            return false
        }
    }

    wipeUser(userId) {
        for (const table of ['conversations', 'interests', 'personality', 'relationships', 'user_aliases', 'user_summaries']) {
            try {
                this.db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(userId)
            } catch {}
        }
        try {
            this.db.prepare('DELETE FROM relationships WHERE related_user_id=?').run(userId)
        } catch {}
        try {
            this.db.prepare('DELETE FROM users WHERE user_id=?').run(userId)
        } catch {}
    }

    cleanupOld(days = 30) {
        const safeDays = Math.max(1, Math.floor(Number(days) || 30))
        const cutoff = `-${safeDays}`
        this.db
            .prepare(`DELETE FROM conversations WHERE timestamp < datetime('now', ? || ' days')`)
            .run(cutoff)
        this.db
            .prepare(
                `DELETE FROM interests WHERE last_mentioned < datetime('now', ? || ' days') AND frequency < 3`,
            )
            .run(cutoff)
        // Orphaned aliases: user has no conversations in last N days
        this.db
            .prepare(
                `DELETE FROM user_aliases WHERE user_id NOT IN (SELECT DISTINCT user_id FROM conversations WHERE timestamp > datetime('now', ? || ' days'))`,
            )
            .run(cutoff)
        // Orphaned relationships: both users inactive
        this.db
            .prepare(
                `DELETE FROM relationships WHERE user_id NOT IN (SELECT DISTINCT user_id FROM conversations WHERE timestamp > datetime('now', ? || ' days'))`,
            )
            .run(cutoff)
        this.db
            .prepare(
                `DELETE FROM relationships WHERE related_user_id NOT IN (SELECT DISTINCT user_id FROM conversations WHERE timestamp > datetime('now', ? || ' days'))`,
            )
            .run(cutoff)
        // Stale personality profiles
        this.db
            .prepare(
                `DELETE FROM personality WHERE user_id NOT IN (SELECT DISTINCT user_id FROM conversations WHERE timestamp > datetime('now', ? || ' days'))`,
            )
            .run(cutoff)
        this.cleanupLore()
        // Gated VACUUM, defaults to once per 7 days to avoid 3-5s blocking ops
        const now = Date.now()
        const gapMs = PERF.maintenance.vacuumEveryDays * 86400_000
        this._lastVacuum ??= 0
        if (now - this._lastVacuum > gapMs) {
            try {
                this.db.prepare('VACUUM').run()
                this._lastVacuum = now
            } catch {}
        }
    }

    // Server lore
    addLore(fact, source = 'manual') {
        if (containsDisallowedHate(fact)) return false
        if (!fact?.trim() || fact.length > 120) return false
        try {
            const existing = this.db.prepare('SELECT id FROM server_lore WHERE fact=?').get(fact.trim())
            if (existing) {
                this.db
                    .prepare(
                        'UPDATE server_lore SET frequency=frequency+1, last_seen=CURRENT_TIMESTAMP WHERE id=?',
                    )
                    .run(existing.id)
            } else {
                const count = this.db.prepare('SELECT COUNT(*) as c FROM server_lore').get()?.c ?? 0
                if (count >= 50) {
                    this.db
                        .prepare(
                            'DELETE FROM server_lore WHERE id=(SELECT id FROM server_lore ORDER BY frequency ASC, last_seen ASC LIMIT 1)',
                        )
                        .run()
                }
                this.db
                    .prepare('INSERT INTO server_lore (fact, source) VALUES (?,?)')
                    .run(fact.trim(), source)
            }
            return true
        } catch {
            return false
        }
    }

    removeLore(id) {
        try {
            this.db.prepare('DELETE FROM server_lore WHERE id=?').run(id)
        } catch {}
    }

    getLore(limit = 12) {
        try {
            return this.db
                .prepare(
                    'SELECT id, fact, source, frequency FROM server_lore ORDER BY frequency DESC, last_seen DESC LIMIT ?',
                )
                .all(limit)
        } catch {
            return []
        }
    }

    cleanupLore() {
        try {
            this.db
                .prepare(
                    `DELETE FROM server_lore WHERE source='auto' AND last_seen < datetime('now', '-30 days')`,
                )
                .run()
            // Purge URL-fragment lore that slipped through before the filter was added
            this.db
                .prepare(
                    `DELETE FROM server_lore WHERE source='auto' AND (
                fact LIKE '%https%' OR fact LIKE '%http%' OR fact LIKE '%tenor%'
                OR fact LIKE '%giphy%' OR fact LIKE '% com %' OR fact LIKE '%discord%'
                OR fact LIKE '%youtube%' OR fact LIKE '%twitch%' OR fact LIKE '%tiktok%'
            )`,
                )
                .run()
        } catch {}
    }
    autoExtractLore(entries) {
        if (!entries || entries.length < 4) return
        const LORE_SIGNALS =
            /\b(our thing|server rule|inside joke|we always|we call|everyone knows|classic|tradition|always happens|server lore)\b/i
        const phraseUsers = new Map()
        for (const e of entries) {
            const text = (e.content ?? '').trim()
            if (containsDisallowedHate(text)) continue
            if (text.length < 8 || text.length > 200) continue
            if (LORE_SIGNALS.test(text)) {
                this.addLore(text.slice(0, 120), 'auto')
                continue
            }
            const words = text.toLowerCase().match(/\b[a-zA-Z]{3,}\b/g) ?? []
            for (let i = 0; i < words.length - 2; i++) {
                const phrase = words.slice(i, i + 3).join(' ')
                if (!phraseUsers.has(phrase)) phraseUsers.set(phrase, new Set())
                phraseUsers.get(phrase).add(e.userId)
            }
        }
        // Skip URL fragments, domain names, and generic web noise, these pollute context badly
        const LORE_URL_JUNK =
            /https?|www\b|\.com|\.net|\.org|\.gg|tenor|giphy|imgur|discord|youtube|twitch|twitter|tiktok/i
        for (const [phrase, users] of phraseUsers) {
            if (users.size >= 3 && !LORE_URL_JUNK.test(phrase))
                this.addLore(`"${phrase}" is a recurring phrase here`, 'auto')
        }
    }
}

// Ghost users system (persistent per-user filter)
class GhostUsers {
    constructor() {
        this._data = {}
        this._saveTimer = null
        this._load()
    }
    _load() {
        try {
            if (existsSync(GHOST_FILE)) this._data = JSON.parse(readFileSync(GHOST_FILE, 'utf8'))
        } catch {}
    }
    _save() {
        // Debounce: coalesce rapid add/remove bursts into a single disk write
        if (this._saveTimer) return
        this._saveTimer = setTimeout(async () => {
            this._saveTimer = null
            try {
                await mkdir('data/ai', { recursive: true })
                await writeFile(GHOST_FILE, JSON.stringify(this._data, null, 2))
            } catch {}
        }, 2000)
    }
    add(userId, targetId) {
        if (!this._data[userId]) this._data[userId] = []
        if (!this._data[userId].includes(targetId)) {
            this._data[userId].push(targetId)
            this._save()
        }
    }
    remove(userId, targetId) {
        if (!this._data[userId]) return
        this._data[userId] = this._data[userId].filter((id) => id !== targetId)
        if (!this._data[userId].length) delete this._data[userId]
        this._save()
    }
    list(userId) {
        return this._data[userId] ?? []
    }
    isGhosted(userId, targetId) {
        return (this._data[userId] ?? []).includes(targetId)
    }
    clear(userId) {
        delete this._data[userId]
        this._save()
    }
}

export { DBPool, dbPool, AIMemoryManager, GhostUsers }
