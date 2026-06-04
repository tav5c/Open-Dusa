import crypto from 'crypto'
import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType,
    EmbedBuilder,
    MessageFlags,
    PermissionFlagsBits,
    SlashCommandBuilder,
} from 'discord.js'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import { LRUCache } from 'lru-cache'
import OpenAI from 'openai'
import { dirname, join } from 'path'
import { performance } from 'perf_hooks'
import { Agent } from 'undici'
import { fileURLToPath } from 'url'
import { loadPerformance } from './performance.js'

const PERF = loadPerformance()
export const _undiciAgent = new Agent({
    connections: 30,
    pipelining: 4,
    keepAliveTimeout: 60_000,
    keepAliveMaxTimeout: 300_000,
    connectTimeout: 8_000,
    headersTimeout: 15_000,
    bodyTimeout: 60_000,
})
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const PREFIX = 'med,'
const DEAD_KEYS_FILE = 'Logs/dead_keys.json'
const GHOST_FILE = 'Ai Database/ghost_users.json'
const ALWAYS_LIVE = new Set([
    'price',
    'prices',
    'cost',
    'how much',
    'market cap',
    'stock price',
    'exchange rate',
    'usd to',
    'eur to',
    'bitcoin',
    'btc',
    'ethereum',
    'eth ',
    'crypto',
    'solana',
    'weather',
    'forecast',
    'rain today',
    'temperature today',
    'prayer time',
    'salah',
    'azan',
    'iftar',
    'suhoor',
    'breaking news',
    'live score',
    'match score',
    'just happened',
    'search ',
    'look up',
    'lookup',
    'google ',
    'find me',
    'ww3',
    'world war 3',
    'war news',
    'latest news',
    'current news',
    'breaking update',
    'release date',
    'is it out yet',
])

const NEVER_RESEARCH_PREFIXES = [
    'i feel',
    'i think',
    'i love',
    'i hate',
    'i miss',
    'i want',
    'i need',
    'i like',
    'i wish',
    'i hope',
    'i cant',
    "i can't",
    "i'm ",
    'im ',
    'i am ',
    'i was ',
    "i've ",
    'i have ',
    "you're",
    'youre',
    'you are',
    'you look',
    'you seem',
    'you always',
    "that's",
    'thats',
    'this is',
    "it's",
    'its ',
    'omg ',
    'oh my',
    'lol ',
    'lmao',
    'haha',
    'aww',
    'aw ',
    'hehe',
    'hihi',
    'okay',
    'ok ',
    'nah ',
    'nah,',
    'yeah ',
    'yep ',
    'nope',
    'same ',
    'same,',
    'mood ',
    'fr ',
    'fr,',
    'no cap',
    'bestie',
    'babe',
    'bby',
    'baby',
    'mommy',
    'mom ',
    'mom,',
    'help me',
    'tell me',
    'talk to',
    'chat with',
    'good morning',
    'good night',
    'good evening',
    'good afternoon',
    'hi ',
    'hey ',
    'hello',
    'heyy',
    'heyyy',
    'hiii',
    'hiiii',
    'wyd',
    'hyd',
    'hru',
    'wbu',
    'ily',
    'idk',
    'ngl',
    'nvm',
    'miss you',
    'love you',
    'thank you',
    'thanks ',
    'ty ',
    'congrats',
    'happy ',
    'sad ',
    'angry ',
    'tired',
    'bored',
    'excited',
    'scared',
    'nervous',
    'only you',
    'just you',
    'in my mind',
    'on my mind',
    'thinking about',
]

const NEVER_RESEARCH_EXACT = new Set([
    'hi',
    'hey',
    'hello',
    'heyy',
    'heyyy',
    'hiii',
    'hihi',
    'hyd',
    'hru',
    'wyd',
    'wbu',
    'ily',
    'idk',
    'ngl',
    'nvm',
    'lol',
    'lmao',
    'lmfao',
    'omg',
    'brb',
    'gtg',
    'ttyl',
    'imo',
    'tbh',
    'fr',
    'lowkey',
    'highkey',
    'slay',
    'vibe',
    'vibing',
    'mood',
    'same',
    'oof',
    'bestie',
    'fam',
    'periodt',
    'no cap',
    'on god',
    'ok',
    'okay',
    'yep',
    'nope',
    'nah',
    'yes',
    'no',
    'sure',
    'maybe',
    'fine',
    'cool',
    'nice',
])

const NO_SEARCH_SIGNALS = [
    'no web search',
    "don't search",
    'dont search',
    'no search',
    'without searching',
    "don't look up",
    'dont look up',
    'no looking up',
    'from your own knowledge',
    'from memory',
    'from your knowledge',
    'just think',
    'use your knowledge',
    "don't use web",
    'dont use web',
    // Discord-native commands (never need a web search)
    'audit log',
    'server log',
    'server info',
    'server stats',
    'bot info',
    'how many servers',
    'warns',
    'stats',
    // User profile / appearance — resolved via RUN_CMD, not web
    'my avatar',
    'my banner',
    'my discord avatar',
    'my discord banner',
    'my profile banner',
    'my profile avatar',
    'profile banner',
    'profile avatar',
    'discord avatar',
    'discord banner',
    'discord profile',
    'show my banner',
    'show my avatar',
    'show my profile',
    'see my banner',
    'see my avatar',
    'our avatar',
    'our banner',
    'server avatar',
    'server banner',
    'server icon',
    'guild icon',
    'guild banner',
    'my pfp',
    'my icon',
    'show pfp',
    'show icon',
]

const NSFW_TERMS = new Set([
    'hentai',
    'doujin hentai',
    'porn',
    'pornhub',
    'xvideos',
    'xnxx',
    'onlyfans',
    'nude',
    'nudes',
    'naked',
    'nsfw',
    'xxx',
    'rule34',
    'nhentai',
    'fakku',
    'hanime',
    'lewd',
    'erotic',
    'explicit sex',
    'blowjob',
    'cum ',
    'orgasm',
    'masturbat',
    'rape',
    'gangbang',
    'incest',
    'loli',
    'shota',
])

const DANGEROUS_TERMS = new Set([
    'how to make a bomb',
    'bomb recipe',
    'synthesize drugs',
    'drug synthesis',
    'make methamphetamine',
    'make fentanyl',
    'ddos attack',
    'doxxing',
    "find someone's address",
    'buy illegal weapons',
])

const CAPABILITIES_NOTE =
    `\n\n[AGENT CAPABILITIES & STRICT BEHAVIOR]\n` +
    `• FIRM RULE: DO NOT emit a <<RUN_CMD>> tag unprompted! Only emit a tag if the user EXPLICITLY asks for an action that matches one of the commands below. For casual chat, reply in plain text ONLY.\n` +
    `• PERSISTENCE: If the user DOES ask for a command below, you MUST execute the matching <<RUN_CMD>> tag. NEVER say "I already did that" as an excuse to skip it. And NEVER announce that an action already succeeded (e.g. "Muted X", "Banned them") in your own words — each command posts its own confirmation embed; just say you're doing it, then append the tag.\n` +
    `• NO INVENTING: You may ONLY use the exact commands listed below. NEVER invent, guess, or approximate command names.\n` +
    `• AGENT POWERS (use ONLY when requested!):\n` +
    `   - Fetch Avatars/Banners: <<RUN_CMD: av 123456789>> | <<RUN_CMD: mav 123456789>> | <<RUN_CMD: bn 123456789>> | <<RUN_CMD: mbn 123456789>>\n` +
    `   - Moderation (use the target's <@id> mention or numeric ID — NEVER a username or "him/her/them" — and include the duration): <<RUN_CMD: mute 123456789 1h reason>> | <<RUN_CMD: warn 123456789 reason>> | <<RUN_CMD: clearwarns 123456789>>\n` +
    `   - Delete Messages: <<RUN_CMD: mpurge 123456789>> | <<RUN_CMD: clear 10>>\n` +
    `   - Manage Server: <<RUN_CMD: createchan text channel-name>> | <<RUN_CMD: delchan 123456789>> | <<RUN_CMD: lockchannel>> | <<RUN_CMD: unlockchannel>> | <<RUN_CMD: auditlogs>>\n` +
    `   - Roles: <<RUN_CMD: addrole 123456789 987654321>> | <<RUN_CMD: removerole 123456789 987654321>> | <<RUN_CMD: listroles>>\n` +
    `   - Self: <<RUN_CMD: setnickname name>> | <<RUN_CMD: renameserver name>> | <<RUN_CMD: addemoji name URL>>\n` +
    `   - Extended: <<RUN_CMD: poll "Question?" "Ans1" "Ans2">> | <<RUN_CMD: thread Name>> | <<RUN_CMD: react 👍>> | <<RUN_CMD: pin ID>> | <<RUN_CMD: unpin ID>> | <<RUN_CMD: slowmode 5>> | <<RUN_CMD: topic new topic>> | <<RUN_CMD: announce CHAN_ID message>> | <<RUN_CMD: movevc USER_ID CHAN_ID>> | <<RUN_CMD: dm USER_ID message>>\n` +
    `• EXECUTION FORMAT: If an action is requested, talk organically FIRST, then cleanly append the <<RUN_CMD>> tag. NEVER write raw prefix commands.\n` +
    `• PINGS: ALWAYS ping using the <@123456789> format. NEVER use plaintext @username.`

const SEARCH_EMOJIS = ['🌐', '📖', '🔍']

function makeIdSet(max, ttl = 30 * 60_000) {
    const lru = new LRUCache({ max, ttl })
    return {
        has: (v) => lru.has(v),
        add: (v) => {
            lru.set(v, 1)
        },
        delete: (v) => lru.delete(v),
        clear: () => lru.clear(),
        get size() {
            return lru.size
        },
    }
}

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
            const { default: Database } = globalThis._sqlite3
            mkdirSync(dirname(path) || '.', { recursive: true })
            const conn = new Database(path)
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
        let base = 'Ai Database'
        if (guildId) {
            const safeName = (guildName || guildId).replace(/[/\\]/g, '_')
            const folder = `${safeName} - ${guildId}`
            base = join('Ai Database', folder)
        }
        this._guildId = guildId
        mkdirSync(base, { recursive: true })
        this.db = dbPool.get(join(base, 'memory.db'))
        this._initSchema()
        this._interestsThrottle = new Map()
        this._personalityThrottle = new Map()
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

    updateInterests(userId, messageContent) {
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

        // Relationships — who this user talks to most
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

        // Server lore — cultural context
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

    wipeUser(userId) {
        for (const table of ['conversations', 'interests', 'personality', 'relationships', 'user_aliases']) {
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

    cleanupOld(days = 90) {
        const safeDays = Math.max(1, Math.floor(Number(days) || 90))
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
        // Gated VACUUM — defaults to once per 7 days to avoid 3-5s blocking ops
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
        // Skip URL fragments, domain names, and generic web noise — these pollute context badly
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
                await mkdir('Ai Database', { recursive: true })
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

class AIChatManager {
    constructor(client, db, config) {
        this.client = client
        this.db = db

        // Config
        this.config = config
        this._config = config
        this.aiModel = config.aiModel ?? 'openai/gpt-oss-120b'
        this.researchModel = config.research_model ?? 'groq/compound-mini'
        this.visionModel = config.vision_model ?? 'meta-llama/llama-4-scout-17b-16e-instruct'
        this.classifierModel = config.classifier_model ?? 'llama-3.1-8b-instant'
        this.capacityFallbacks = config.fallback_models ?? [
            'llama-3.3-70b-versatile',
            'qwen/qwen3-32b',
            'llama-3.1-8b-instant',
        ]
        const _sp = config.systemPrompt
        this.instructions = Array.isArray(_sp)
            ? _sp.join(String.fromCharCode(10))
            : typeof _sp === 'string' && _sp.trim()
              ? _sp
              : 'You are Medusa, a warm and witty Discord AI resident. Respond in first person.'
        this.maxHistory = config.memoryDepth ?? PERF.ai.memoryDepth
        this.allowDM = config.allowDMs ?? false
        this.FunMsgInterval = (config.FunMsgInterval ?? 5400) * 1000

        // Advanced LLM Tuning
        this.temperature = config.temperature ?? 0.9
        this.topP = config.topP ?? 1.0
        this.chatTokens = config.chatTokens ?? 1024
        this.researchTemp = config.researchTemp ?? 0.6
        this.searchTokens = config.searchTokens ?? 1500
        this.visionTemp = config.visionTemp ?? 0.3
        this.visionTokens = config.visionTokens ?? 512
        this.allowedGuilds = new Set((config.guilds ?? []).map(String))
        this.aiAllowedGuilds = new Set((config.ai_allowed_guilds ?? []).map(String))
        this.alwaysActiveCh = new Set((config.always_active_channels ?? []).map(String))
        this.funChannels = new Set((config.fun_channels ?? []).map(String))
        this.isolatedServers = new Set((config.isolated_servers ?? []).map(String))

        const triggers = config.triggers ?? 'medusa'
        this.triggerWords = (Array.isArray(triggers) ? triggers : triggers.split(','))
            .map((t) => t.trim().toLowerCase())
            .filter(Boolean)
        // Pre-compile trigger regexes once (avoids re-compilation on every message)
        this._triggerRegexes = this.triggerWords.map(
            (w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`),
        )

        // API keys
        this.aiTokens = Array.isArray(config.llm_keys)
            ? config.llm_keys.filter((v) => typeof v === 'string' && v.length > 20)
            : []
        this.llmBaseUrl = config.llm_base_url || 'https://api.groq.com/openai/v1'
        this.ownerId = config.owner_id
        this.ownerName = config.owner_name || 'My Developer'
        this.currentKeyIdx = 0
        this.deadKeys = new Set()
        this.keyFailures = {}
        this.researchKeys = Array.isArray(config.research_key)
            ? config.research_key.filter((k) => typeof k === 'string' && k.length > 20)
            : config.research_key
              ? [config.research_key]
              : []
        this.currentResearchKeyIdx = 0
        this.maxFailures = 2
        this._pendingConfirms = new Map()
        this._loadDeadKeys()
        this._groq = null
        this._initGroq()
        this._initProviders()

        // Caches
        const P = PERF.ai
        this.responseCache = new LRUCache({
            max: P.responseCacheMax,
            ttl: P.responseCacheTTLSec * 1000,
            updateAgeOnGet: true,
            allowStale: true,
            maxSize: P.responseCacheMaxMB * 1024 * 1024,
            sizeCalculation: (value) => (typeof value === 'string' ? value.length : 1024),
        })
        this.userCache = new LRUCache({ max: P.userCacheMax, ttl: P.userCacheTTLSec * 1000 })
        this.summarizeCDs = new Map()

        // Runtime state
        this.messageHistory = new LRUCache({ max: P.messageHistoryMax, ttl: P.messageHistoryTTLMin * 60_000 })
        this.repliedMsgCache = new LRUCache({
            max: P.repliedMsgCacheMax,
            ttl: P.repliedMsgCacheTTLMin * 60_000,
        })
        this.activeConvs = new Map()
        this.processedMsgIds = makeIdSet(2500, 30 * 60_000)
        this.triggeredMsgs = makeIdSet(1000, 15 * 60_000)
        this.spamProtect = new Map()
        this.userMsgCounts = new Map()
        this.userCooldowns = new Map()
        this.msgQueues = new Map()
        this.spamThreshold = 5
        this.spamWindow = 10_000
        this.cooldownDuration = 60_000
        this.convTimeout = 100_000
        this.paused = false
        this.ignoreUsers = new Set((config.ignore_users ?? []).map(String))
        this.pingMode = config.ping_mode ?? true
        this.replyPing = config.reply_ping ?? true // whether to re-ping the user in split replies
        this._config = config
        // Memory managers
        this.globalMem = new AIMemoryManager()
        this.isolatedMems = new Map()

        // Custom prompts / modes
        this.customPrompts = this._loadJSON('Ai Database/custom_prompts.json', {})
        this.userModes = this._loadJSON('Ai Database/user_modes.json', {})

        // Ghost users
        this.ghost = new GhostUsers()

        // Misc
        this.totalRequests = 0
        this.errorCount = 0
        this.responseTimes = []
        this.lastRandomMsg = Date.now()

        // Background tasks
        setInterval(() => this._periodicCleanup(), PERF.maintenance.cleanupIntervalMin * 60_000).unref()
        if (this.funChannels.size && this.FunMsgInterval > 0) {
            setInterval(() => {
                if (Date.now() - this.lastRandomMsg >= this.FunMsgInterval && !this.paused)
                    this.sendRandomMessage()
            }, 60_000).unref()
        }
        setInterval(() => {
            const cutoff = Date.now() - 30 * 60_000
            for (const [key, hist] of this.messageHistory) {
                if (!Array.isArray(hist) || hist.length === 0) {
                    this.messageHistory.delete(key)
                    continue
                }
                const lastMsgTime = this.activeConvs.get(key) ?? 0
                if (lastMsgTime < cutoff) {
                    this.messageHistory.delete(key)
                    const [userId] = key.split('-')
                    this._invalidateUserCache(userId)
                }
            }
        }, 30 * 60_000).unref()
    }
    // Init helpers
    _loadJSON(path, fallback) {
        try {
            if (!existsSync(path)) return fallback
            const raw = readFileSync(path, 'utf8')
            return JSON.parse(raw.replace(/\b(\d{15,})\b/g, '"$1"'))
        } catch {}
        return fallback
    }
    async _saveJSON(path, data) {
        try {
            await mkdir(path.split('/').slice(0, -1).join('/'), { recursive: true })
            await writeFile(path, JSON.stringify(data, null, 2))
        } catch {}
    }
    _initGroq() {
        const key = this.aiTokens[this.currentKeyIdx]
        if (!key) {
            console.error('[AI] No API key found in config')
            return
        }

        const createClient = (baseURL, apiKey, timeout, retries) => {
            const opts = { apiKey, baseURL, timeout, maxRetries: retries }
            // NVIDIA NIM uses api-key header instead of Bearer
            if (baseURL?.includes('nvidia.com') || baseURL?.includes('integrate.api.nvidia')) {
                opts.defaultHeaders = { Authorization: `Bearer ${apiKey}` }
            }
            // OpenRouter needs extra headers for routing
            if (baseURL?.includes('openrouter.ai')) {
                opts.defaultHeaders = {
                    Authorization: `Bearer ${apiKey}`,
                    'HTTP-Referer': this._config?.site_url || 'https://medusa.bot',
                    'X-Title': 'Medusa',
                }
            }
            // Anthropic via OpenAI compatibility layer
            if (baseURL?.includes('anthropic')) {
                opts.defaultHeaders = { 'anthropic-version': '2023-06-01' }
            }
            return new OpenAI(opts)
        }

        try {
            this._groq = createClient(this.llmBaseUrl, key, 12_000, 0)
            this._groqResearch = createClient(this.llmBaseUrl, key, 45_000, 0)

            const researchUrl = (this._config ?? this.config).research_base_url
            const researchKey = this.researchKeys?.length
                ? this.researchKeys[this.currentResearchKeyIdx ?? 0]
                : key
            this._researchClient = researchUrl
                ? createClient(researchUrl, researchKey, 60_000, 1)
                : this._groqResearch
        } catch (e) {
            console.error('[AI] LLM client init failed:', e)
            this._groq = null
            this._groqResearch = null
            this._researchClient = null
        }

        // Optional Tavily client — wakes up the `else if (this._tavily)` branch in _callResearch.
        // Dynamic import via .then() because _initGroq is synchronous (called from constructor).
        const tavilyKey = (this._config ?? this.config).tavily_key
        if (tavilyKey && !this._tavily) {
            import('@tavily/core')
                .then(({ tavily }) => {
                    this._tavily = tavily({ apiKey: tavilyKey })
                    console.log('[AI] Tavily client initialized')
                })
                .catch((e) => {
                    console.warn('[AI] Tavily import failed — run `npm i @tavily/core` to enable:', e.message)
                })
        }
    }
    /**
     * Providers array from config. Falls back to the single `llm_base_url`/`llm_keys`
     * pair if no array is configured. Each provider has its own circuit-breaker state.
     */
    _initProviders() {
        const raw = this._config?.providers
        const list =
            Array.isArray(raw) && raw.length
                ? [...raw].sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
                : [
                      {
                          name: 'default',
                          base_url: this.llmBaseUrl,
                          keys: this.aiTokens,
                          model: this.aiModel,
                          priority: 1,
                      },
                  ]

        this._providers = list.map((p) => ({
            ...p,
            client: null,
            state: { failures: 0, openUntil: 0 },
        }))
        this._rebuildProviderClients()
    }

    _rebuildProviderClients() {
        for (const p of this._providers) {
            const key = (p.keys ?? [])[0]
            if (!key) {
                p.client = null
                continue
            }
            try {
                p.client = new OpenAI({ apiKey: key, baseURL: p.base_url, timeout: 12_000, maxRetries: 0 })
            } catch {
                p.client = null
            }
        }
    }

    _tripBreaker(p, err) {
        p.state.failures++
        if (p.state.failures >= 3) {
            p.state.openUntil = Date.now() + 60_000 // half-open after 1 min
            p.state.failures = 0
            console.warn(`[AI] Provider '${p.name}' circuit OPEN for 60s (${String(err).slice(0, 80)})`)
        }
    }

    _resetBreaker(p) {
        if (p.state.failures || p.state.openUntil) {
            p.state.failures = 0
            p.state.openUntil = 0
        }
    }

    /**
     * Try each configured provider in priority order until one returns a non-null reply
     * or all of them are either circuit-open or exhausted. Capacity/503 errors don't count
     * against a provider as long as its other keys still respond.
     */
    async _routedCall(messages, maxTokens, temp, topP) {
        if (!this._providers) this._initProviders()
        const now = Date.now()
        for (const p of this._providers) {
            if (!p.client) continue
            if (now < p.state.openUntil) continue // breaker open
            try {
                const payload = {
                    ...this._buildPayload(p.model ?? this.aiModel, messages, maxTokens, temp, topP),
                    stream: false,
                }
                const r = await p.client.chat.completions.create(payload)
                const out = r.choices?.[0]?.message?.content
                if (out) {
                    this._resetBreaker(p)
                    return out
                }
                this._tripBreaker(p, 'empty response')
            } catch (e) {
                const err = String(e).toLowerCase()
                if (this._isCapacityError(err)) continue // try next provider, don't trip
                this._tripBreaker(p, err)
            }
        }
        return null
    }

    _loadDeadKeys() {
        try {
            if (existsSync(DEAD_KEYS_FILE)) {
                const raw = readFileSync(DEAD_KEYS_FILE, 'utf8')
                if (!raw.trim()) return // Prevent parsing empty files
                const d = JSON.parse(raw)
                const n = this.aiTokens.length
                this.deadKeys = new Set((d.dead_indices ?? []).filter((i) => i < n))
                while (this.deadKeys.has(this.currentKeyIdx) && this.currentKeyIdx < n) this.currentKeyIdx++
                if (this.currentKeyIdx >= n)
                    this.currentKeyIdx = [...Array(n).keys()].find((i) => !this.deadKeys.has(i)) ?? 0
                if (this.deadKeys.size)
                    console.log(`[AI] Restored ${this.deadKeys.size} dead key(s):`, [...this.deadKeys])
            }
        } catch (e) {
            console.error('[AI] Could not load dead keys:', e)
        }
    }
    _saveDeadKeys() {
        try {
            mkdirSync('Logs', { recursive: true })
            writeFileSync(DEAD_KEYS_FILE, JSON.stringify({ dead_indices: [...this.deadKeys].sort() }))
        } catch {}
    }

    getMem(guild) {
        if (!guild || !this.isolatedServers.has(guild.id)) return this.globalMem
        if (!this.isolatedMems.has(guild.id)) {
            this._resolveAndSync(guild)
            this.isolatedMems.set(guild.id, new AIMemoryManager(guild.id, guild.name))
        }
        return this.isolatedMems.get(guild.id)
    }

    /** Scan Ai Database/ for any folder ending with " - {guildId}" and rename it if the guild name changed */
    _resolveAndSync(guild) {
        try {
            const dataDir = 'Ai Database'
            if (!existsSync(dataDir)) return
            const suffix = ` - ${guild.id}`
            const safeName = guild.name.replace(/[/\\]/g, '_')
            const expectedFolder = `${safeName}${suffix}`
            const expectedPath = join(dataDir, expectedFolder)
            // Check for bare-ID folder left by migration and rename it first
            const bareDir = join(dataDir, guild.id)
            if (existsSync(bareDir) && !existsSync(expectedPath)) {
                try {
                    renameSync(bareDir, expectedPath)
                    console.log(`[AI] Renamed bare-ID folder "${guild.id}" → "${expectedFolder}"`)
                } catch (e) {
                    console.warn(`[AI] Could not rename bare-ID folder:`, e.message)
                }
                return
            }
            for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
                if (!entry.isDirectory() || !entry.name.endsWith(suffix)) continue
                if (entry.name === expectedFolder) return
                // Found old-name folder — rename to match current guild name
                const oldPath = join(dataDir, entry.name)
                try {
                    renameSync(oldPath, expectedPath)
                    console.log(`[AI] Synced folder: "${entry.name}" → "${expectedFolder}"`)
                } catch (e) {
                    console.warn(`[AI] Could not sync folder "${entry.name}":`, e.message)
                }
                return
            }
        } catch {}
    }

    getUserPrompt(userId) {
        if (!userId) return this.instructions
        if (this.userModes[userId] === 1)
            return `You are Medusa in focused mode. Highly intelligent and analytical. Concise and direct. Task-oriented and solution-focused. Professional but still personable. Skip casual chat, focus on helping efficiently. Use minimal emojis, be more formal. Get straight to the point. Respond in first person as Medusa.`
        if (this.customPrompts[userId]) return this.customPrompts[userId]
        return this.instructions
    }

    // Key rotation with per-key cooldown to prevent thrashing when all keys are rate-limited.
    // Without this, 2 limited keys ping-pong every few seconds burning logs and TTFT.
    async rotateKey(errorMsg = '') {
        if (this._rotatePromise) return this._rotatePromise

        this._rotatePromise = (async () => {
            const n = this.aiTokens.length
            if (!n) return false
            const old = this.currentKeyIdx
            this._keyCooldowns ??= new Map() // keyIdx -> timestamp when it becomes usable again

            if (this._isDeadKeyError(errorMsg)) {
                this.deadKeys.add(old)
                this._saveDeadKeys()
                console.log(`[AI] Key ${old + 1} permanently blacklisted`)
            } else if (this._isRateError(errorMsg)) {
                // Put the current key on 30s cooldown. If all keys are cooling down,
                // we'll just wait out the shortest one rather than ping-ponging.
                this._keyCooldowns.set(old, Date.now() + 30_000)
            }

            const now = Date.now()
            // Find a non-dead, non-cooling key
            for (let step = 1; step <= n; step++) {
                const next = (old + step) % n
                if (this.deadKeys.has(next)) continue
                const cooldownUntil = this._keyCooldowns.get(next) ?? 0
                if (cooldownUntil > now) continue
                this.currentKeyIdx = next
                this._initGroq()
                if (this._groq) {
                    this.keyFailures[old] = 0
                    console.log(`[AI] Key rotated: ${old + 1} → ${next + 1}`)
                    return true
                }
            }

            // All keys cooling down. Wait for the earliest one to recover rather than failing.
            const aliveCooldowns = [...this._keyCooldowns.entries()]
                .filter(([k]) => !this.deadKeys.has(k))
                .map(([, t]) => t)
            if (aliveCooldowns.length) {
                const waitMs = Math.max(0, Math.min(...aliveCooldowns) - Date.now())
                if (waitMs > 0 && waitMs < 60_000) {
                    console.log(`[AI] All keys cooling down — waiting ${(waitMs / 1000).toFixed(1)}s`)
                    await new Promise((r) => setTimeout(r, waitMs + 100))
                    // Retry once
                    for (let step = 0; step < n; step++) {
                        const next = (old + step) % n
                        if (this.deadKeys.has(next)) continue
                        if ((this._keyCooldowns.get(next) ?? 0) > Date.now()) continue
                        this.currentKeyIdx = next
                        this._initGroq()
                        if (this._groq) {
                            console.log(`[AI] Key recovered after cooldown: key ${next + 1}`)
                            return true
                        }
                    }
                }
            }

            console.warn(
                `[AI] All keys exhausted (${this.deadKeys.size} dead, ${this._keyCooldowns.size} cooling)`,
            )
            return false
        })()

        try {
            return await this._rotatePromise
        } finally {
            this._rotatePromise = null
        }
    }

    _isRateError(e) {
        const s = String(e).toLowerCase()
        return [
            'rate limit',
            'quota exceeded',
            'too many requests',
            'limit exceeded',
            'billing',
            'insufficient credits',
            'expired',
            'invalid api key',
            'authentication failed',
            'unauthorized',
            'restricted',
            'organization has been',
            'account suspended',
            'access denied',
            '401',
            '403',
            '429',
            '413',
            '529',
        ].some((x) => s.includes(x))
    }
    _isDeadKeyError(e) {
        const s = String(e).toLowerCase()
        const HARD_DEAD = [
            'organization has been restricted',
            'organization has been disabled',
            'account has been disabled',
            'account has been suspended',
            'key has been revoked',
            'api key not valid',
            'invalid api key provided',
        ]
        return HARD_DEAD.some((x) => s.includes(x))
    }
    _isCapacityError(e) {
        const s = String(e).toLowerCase()
        return (
            (s.includes('503') || s.includes('498')) &&
            (s.includes('over capacity') ||
                s.includes('service unavailable') ||
                s.includes('currently unavailable') ||
                s.includes('capacity'))
        )
    }

    static PROVIDERS = [
        {
            id: 'nvidia',
            match: (url, model) => /nvidia\.com|integrate\.api\.nvidia/i.test(url),
            paramMap: (p, maxTokens) => {
                p.max_completion_tokens = maxTokens
                return p
            },
        },
        {
            id: 'anthropic',
            match: (url) => /anthropic/i.test(url),
            paramMap: (p, maxTokens) => {
                p.max_tokens = maxTokens
                delete p.top_p
                return p
            },
        },
        {
            id: 'google',
            match: (url, model) => /google|generativelanguage/i.test(url) || /gemini/i.test(model),
            paramMap: (p, maxTokens) => {
                p.maxOutputTokens = maxTokens
                p.temperature = Math.min(p.temperature ?? 1, 0.9)
                return p
            },
        },
        {
            id: 'openrouter',
            match: (url) => /openrouter\.ai/i.test(url),
            paramMap: (p, maxTokens) => {
                p.max_completion_tokens = maxTokens
                return p
            },
        },
        {
            id: 'groq',
            match: (url) => /groq\.com/i.test(url),
            paramMap: (p, maxTokens) => {
                p.max_completion_tokens = maxTokens
                return p
            },
        },
        // Default (OpenAI + anything OpenAI-compatible)
        {
            id: 'openai',
            match: () => true,
            paramMap: (p, maxTokens) => {
                p.max_completion_tokens = maxTokens
                return p
            },
        },
    ]

    _detectProvider(model) {
        const url = this.llmBaseUrl || ''
        return AIChatManager.PROVIDERS.find((p) => p.match(url, model))
    }

    _buildPayload(model, messages, maxTokens, temp, topP) {
        let payload = {
            model,
            messages,
            temperature: temp ?? this.temperature,
            top_p: topP ?? this.topP,
        }
        const provider = this._detectProvider(model)
        payload = provider.paramMap(payload, maxTokens ?? this.chatTokens)

        // Reasoning models (OpenAI o1/o3, DeepSeek-R, gpt-oss)
        if (/\bo[13]\b|deepseek-r|gpt-oss/i.test(model)) {
            payload.reasoning_effort = 'low'
            if (!/gpt-oss/i.test(model)) {
                delete payload.temperature
                delete payload.top_p
            }
        }

        if (this._config?.stop_sequences?.length) payload.stop = this._config.stop_sequences
        if (this._config?.streaming === true) payload.stream = true

        return payload
    }

    async _groqCall(messages, model, maxTokens, temp, topP) {
        if (!this._groq) return null

        const payload = this._buildPayload(model, messages, maxTokens, temp, topP)
        try {
            const r = await this._groq.chat.completions.create(payload)
            this.keyFailures[this.currentKeyIdx] = 0
            return r.choices[0].message.content
        } catch (e) {
            const err = String(e)
            if (this._isCapacityError(err)) return { capacityError: true }
            this.keyFailures[this.currentKeyIdx] = (this.keyFailures[this.currentKeyIdx] ?? 0) + 1

            if (this._isRateError(err) || this.keyFailures[this.currentKeyIdx] >= this.maxFailures) {
                // Check if we have multiple keys to rotate through. If only 1 key, we must respect retry-after.
                const retryAfterSec = e?.headers?.['retry-after'] ?? e?.response?.headers?.['retry-after']
                if (this.aiTokens.length <= 1 && retryAfterSec && !this._isDeadKeyError(err)) {
                    const waitMs = Math.min(parseFloat(retryAfterSec) * 1000, 30_000)
                    console.log(`[AI] 429 retry-after: waiting ${waitMs}ms (only 1 key available)`)
                    await new Promise((r) => setTimeout(r, waitMs))
                }
                if (await this.rotateKey(err)) {
                    try {
                        const r2 = await this._groq.chat.completions.create(payload)
                        return r2.choices[0].message.content
                    } catch {
                        return null
                    }
                }
            }
            return null
        }
    }

    // Streams a completion into a live-editing message; falls back to non-streaming on error.
    async _streamChat(messages, model, maxTokens, temp, message) {
        if (!this._groq) return null
        const payload = { ...this._buildPayload(model, messages, maxTokens, temp), stream: true }
        let placeholder = null
        let full = ''
        let lastEdit = 0
        const EDIT_MS = 500 // 2 edits/s
        const MAX_LEN = 1900 // leave room for the streaming cursor glyph

        try {
            const stream = await this._groq.chat.completions.create(payload)
            placeholder = await this.secureReply(message, '…', { allowedMentions: { parse: [] } })
            for await (const chunk of stream) {
                const delta = chunk.choices?.[0]?.delta?.content ?? ''
                if (!delta) continue
                full += delta
                const now = Date.now()
                if (placeholder && now - lastEdit >= EDIT_MS && full.length <= MAX_LEN) {
                    lastEdit = now
                    placeholder.edit(full + ' ▌').catch(() => {})
                }
                if (full.length > MAX_LEN) break // let splitResponse + secureReply handle the rest
            }
            if (placeholder) {
                const finalText = this.finalSecurityCheck(full.slice(0, 2000))
                if (finalText.trim()) placeholder.edit(finalText).catch(() => {})
                else placeholder.delete().catch(() => {})
            }
            return full || null
        } catch (e) {
            console.warn('[AI] stream failed, falling back to non-stream:', String(e).slice(0, 160))
            if (placeholder) placeholder.delete().catch(() => {})
            return this._groqCallWithFallbacks(messages, model, maxTokens, temp)
        }
    }

    async _groqCallWithFallbacks(messages, model, maxTokens = 2500, temp = this.temperature, topP) {
        // Prefer the multi-provider router when configured. Falls back to
        // single-provider with capacity-model fallbacks on total router miss.
        if (this._providers?.length > 1) {
            const routed = await this._routedCall(messages, maxTokens, temp, topP)
            if (routed) return routed
        }
        const result = await this._groqCall(messages, model, maxTokens, temp, topP)
        if (result && !result.capacityError) return result
        for (const fb of this.capacityFallbacks) {
            if (fb === model) continue
            try {
                const r = await this._groq.chat.completions.create({
                    model: fb,
                    messages,
                    max_completion_tokens: maxTokens,
                    temperature: temp,
                    top_p: topP ?? 1,
                })
                return r.choices[0].message.content
            } catch (e) {
                // Capacity error -> try the next fallback model; any other error -> stop.
                if (this._isCapacityError(String(e))) continue
                break
            }
        }
        return null
    }

    // Research pipeline
    // Detect Groq's 400 tool_use_failed ("Failed to call a function") so we can retry without tools.
    _isToolCallError(err) {
        if (err?.status !== 400 && err?.statusCode !== 400) return false
        const s = `${err?.code ?? ''} ${err?.message ?? ''} ${err?.error?.message ?? ''}`.toLowerCase()
        return (
            s.includes('tool_use_failed') ||
            s.includes('failed_generation') ||
            s.includes('failed to call a function') ||
            (s.includes('function') && s.includes('adjust your prompt'))
        )
    }

    async _callResearch(prompt) {
        if (!this._researchClient) return null

        const serperKey = (this._config ?? this.config).serper_key
        const tavilyKey = (this._config ?? this.config).tavily_key
        const searchTool = {
            type: 'function',
            function: {
                name: 'web_search',
                description:
                    'Search the web for current information, news, prices, weather, or anything that requires up-to-date data.',
                parameters: {
                    type: 'object',
                    properties: {
                        query: {
                            type: 'string',
                            description: 'The search query to look up',
                        },
                    },
                    required: ['query'],
                },
            },
        }

        const messages = [
            {
                role: 'system',
                content:
                    'You are a precise research assistant. Use the web_search tool to find current information when needed. Synthesize results factually. End with: SOURCES: [Name](url) — max 3 real URLs. Omit if none.',
            },
            { role: 'user', content: prompt.slice(0, 800) },
        ]

        const hasSearch = !!(serperKey || tavilyKey)
        try {
            // Bounded tool-calling loop. Tools stay attached on every round so tool_choice is
            // never implicitly "none" while the model might still emit a call — that mismatch is
            // exactly what triggers the provider's 400 tool_use_failed (Tool choice is none, but
            // model called a tool). The round cap prevents runaway search loops.
            const MAX_ROUNDS = 4
            const convo = [...messages]
            for (let round = 0; round < MAX_ROUNDS; round++) {
                // Lower temp on tool rounds — high temp is the main cause of malformed tool-call JSON.
                const toolRoundTemp = Math.min(this.researchTemp, 0.3)
                const runRound = (useTools) =>
                    this._researchClient.chat.completions.create({
                        model: this.researchModel,
                        messages: convo,
                        tools: useTools ? [searchTool] : undefined,
                        tool_choice: useTools ? 'auto' : undefined,
                        max_completion_tokens: this.searchTokens,
                        temperature: useTools ? toolRoundTemp : this.researchTemp,
                        top_p: this.topP,
                    })
                let r
                try {
                    r = await runRound(hasSearch)
                } catch (err) {
                    // Groq 400 tool_use_failed: the model emitted a malformed tool call. Retry this
                    // round WITHOUT tools so the research model still answers from context gathered
                    // so far, instead of crashing out to the primary (search-less) fallback.
                    if (hasSearch && this._isToolCallError(err)) {
                        r = await runRound(false)
                    } else {
                        throw err
                    }
                }

                const msg = r.choices?.[0]?.message
                if (!msg) return null

                // No tool call means this is the final synthesized answer.
                if (!msg.tool_calls?.length) {
                    return msg.content ?? null
                }

                // Record the assistant turn that requested the tool calls.
                convo.push({ role: 'assistant', content: msg.content ?? '', tool_calls: msg.tool_calls })

                // Execute every tool call the model requested.
                const toolResults = await Promise.all(
                    msg.tool_calls.map(async (tc) => {
                        let result = 'No results found.'
                        try {
                            const args = JSON.parse(tc.function.arguments)
                            const query = args.query

                            if (serperKey) {
                                const res = await fetch('https://google.serper.dev/search', {
                                    method: 'POST',
                                    headers: { 'X-API-KEY': serperKey, 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ q: query, num: 5 }),
                                    signal: AbortSignal.timeout(8000),
                                })
                                const data = await res.json()
                                const organic = data.organic ?? []
                                const snippets = organic
                                    .map((r, i) => `[${i + 1}] ${r.title}\n${r.snippet}\nURL: ${r.link}`)
                                    .join('\n\n')
                                const answer = data.answerBox?.answer ?? data.answerBox?.snippet ?? ''
                                result = answer
                                    ? `Quick answer: ${answer}\n\n${snippets}`
                                    : snippets || 'No results.'
                            } else if (this._tavily) {
                                // Tavily JS SDK: tavily({apiKey}).search(query, { maxResults, searchDepth, includeAnswer })
                                // https://docs.tavily.com/sdk/javascript/reference
                                const tr = await this._tavily.search(query, {
                                    maxResults: 5,
                                    searchDepth: 'basic',
                                    includeAnswer: true,
                                })
                                const snippets = (tr.results ?? [])
                                    .map(
                                        (r, i) => `[${i + 1}] ${r.title}
                            ${(r.content ?? '').slice(0, 400)}
                            URL: ${r.url}`,
                                    )
                                    .join('')
                                result = tr.answer
                                    ? `Quick answer: ${tr.answer}
                            ${snippets}`
                                    : snippets
                            } else {
                                // No search provider configured — tell the model to answer from knowledge
                                result =
                                    'No external search tool available. Answer using only your training data and be honest about uncertainty.'
                            }
                        } catch (e) {
                            result = `Search failed: ${String(e).slice(0, 100)}`
                        }

                        return {
                            role: 'tool',
                            tool_call_id: tc.id,
                            content: result,
                        }
                    }),
                )

                // Feed results back; the loop decides whether to search again or synthesize.
                convo.push(...toolResults)
            }

            // Round cap reached without a plain-text answer — force one final synthesis pass.
            const fin = await this._researchClient.chat.completions.create({
                model: this.researchModel,
                messages: [
                    ...convo,
                    {
                        role: 'system',
                        content: 'Stop searching. Answer now using the information gathered above.',
                    },
                ],
                max_completion_tokens: this.searchTokens,
                temperature: this.researchTemp,
                top_p: this.topP,
            })
            return fin.choices?.[0]?.message?.content ?? null
        } catch (e) {
            console.error('[AI] _callResearch failed:', String(e).slice(0, 300))
            // Last-ditch: ask the primary chat client to answer from its own knowledge
            if (this._groq) {
                try {
                    const r = await this._groq.chat.completions.create({
                        model: this.aiModel,
                        messages: [
                            {
                                role: 'system',
                                content:
                                    'Answer factually from your knowledge. If unsure, say so briefly. No fake URLs.',
                            },
                            { role: 'user', content: prompt.slice(0, 800) },
                        ],
                        max_completion_tokens: 800,
                        temperature: 0.3,
                    })
                    return r.choices[0]?.message?.content ?? null
                } catch {}
            }
            return null
        }
    }

    _parseSources(raw) {
        const match = raw.match(/\n*SOURCES\s*:\s*(.+?)$/is)
        if (!match) return { text: raw.trim(), sources: [] }
        const text = raw.slice(0, match.index).trim()
        const sources = [...match[1].matchAll(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g)]
            .slice(0, 3)
            .map((m) => ({ name: m[1].trim(), url: m[2].trim() }))
        return { text, sources }
    }

    _extractSearchQuery(prompt) {
        let q = prompt.trim()
        // Strip leading greetings and filler words
        q = q.replace(/^(?:hi+|hey+|yo+|sup|hello|oi|ok|okay)[,!\s]+/i, '').trim()
        const you = '(?:you|u|ya)'
        const prefixes = [
            new RegExp(
                `^(?:can ${you}\\s+|could ${you}\\s+)?(?:please\\s+)?(?:make a\\s+|do a\\s+|make\\s+|do\\s+)?research\\s+(?:about|on|for)\\s+`,
                'i',
            ),
            new RegExp(
                `^(?:can ${you}\\s+|could ${you}\\s+)?(?:please\\s+)?search(?:\\s+up|\\s+for)?\\s+`,
                'i',
            ),
            new RegExp(`^(?:can ${you}\\s+|could ${you}\\s+)?(?:please\\s+)?look\\s+up\\s+`, 'i'),
            new RegExp(`^(?:can ${you}\\s+|could ${you}\\s+)?(?:please\\s+)?lookup\\s+`, 'i'),
            new RegExp(`^(?:can ${you}\\s+|could ${you}\\s+)?(?:please\\s+)?find(?:\\s+me)?\\s+`, 'i'),
            new RegExp(`^(?:can ${you}\\s+|could ${you}\\s+)?(?:please\\s+)?tell me about\\s+`, 'i'),
            new RegExp(`^(?:can ${you}\\s+|could ${you}\\s+)?(?:please\\s+)?what(?:'s| is)\\s+`, 'i'),
            new RegExp(`^(?:can ${you}\\s+|could ${you}\\s+)?(?:please\\s+)?who(?:'s| is)\\s+`, 'i'),
            new RegExp(`^(?:can ${you}\\s+|could ${you}\\s+)?(?:please\\s+)?google\\s+`, 'i'),
            new RegExp(`^(?:can ${you}\\s+|could ${you}\\s+)?(?:please\\s+)?show me\\s+`, 'i'),
            /^research\s+/i,
        ]
        for (const p of prefixes) q = q.replace(p, '').trim()
        q = q.replace(/\s+for me\.?$|\s+please\.?$/i, '').trim()
        return q.length > 3 ? q : prompt.trim()
    }
    // Reply context resolution
    // Fetches the replied-to message when reference.resolved is null (uncached).
    // Builds a rich context object covering text, images, links and embeds —
    async _resolveReplyContext(message) {
        if (!message.reference?.messageId) return null
        if (message._medusaReplyCtx !== undefined) return message._medusaReplyCtx
        let ref = message.reference.resolved
        if (!ref) {
            try {
                ref = await message.channel.messages.fetch(message.reference.messageId)
            } catch {
                message._medusaReplyCtx = null
                return null
            }
        }
        if (!ref) {
            message._medusaReplyCtx = null
            return null
        }
        this.repliedMsgCache.set(message.id, ref)

        const authorName = ref.member?.displayName ?? ref.author.username
        const isBot = ref.author.id === this.client.user.id
        const label = isBot ? 'your message' : `${authorName}'s message`

        // Collect all content from the replied message
        const parts = []

        // Text content (full, not truncated)
        if (ref.content?.trim()) parts.push(ref.content.trim())

        // Forwarded message snapshots (Discord message forwards have no content, only snapshots)
        if (!ref.content?.trim() && ref.messageSnapshots?.size) {
            for (const snapshot of ref.messageSnapshots.values()) {
                const snapText = snapshot.message?.content?.trim()
                if (snapText) parts.push(`[Forwarded message]\n${snapText.slice(0, 1200)}`)
            }
        }

        // Attachments that aren't images (images handled separately via vision)
        for (const att of ref.attachments.values()) {
            const ct = (att.contentType ?? '').split(';')[0].trim().toLowerCase()
            const isImg = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'].includes(ct)
            if (!isImg) parts.push(`[Attachment: ${att.name} — ${att.url}]`)
        }

        // Embeds: links, rich embeds, articles — incl. fields/footer/provider where bots (Last.fm, "now playing", etc.) put the real payload
        for (const embed of ref.embeds) {
            const etype = embed.data?.type
            if (etype === 'gifv' || etype === 'image') continue // handled by vision
            const bits = []
            if (embed.author?.name) bits.push(`From: ${embed.author.name}`)
            if (embed.title) bits.push(`Title: ${embed.title}`)
            if (embed.description) bits.push(`Description: ${embed.description.slice(0, 400)}`)
            for (const f of embed.fields ?? []) {
                const fn = (f?.name ?? '').trim()
                const fv = (f?.value ?? '').trim()
                if (fn || fv) bits.push(`${fn}: ${fv}`.slice(0, 200))
            }
            if (embed.footer?.text) bits.push(`Footer: ${embed.footer.text}`)
            if (embed.provider?.name) bits.push(`Via: ${embed.provider.name}`)
            if (embed.url) bits.push(`URL: ${embed.url}`)
            if (bits.length) parts.push(`[Embed — ${bits.join(' | ')}]`)
        }

        // Stickers
        for (const sticker of ref.stickers.values()) parts.push(`[Sticker: ${sticker.name}]`)

        const textContext = parts.join('\n')

        if (this._config?.debug === true) {
            console.log(
                `[AI][replyctx] embeds=${ref.embeds?.length ?? 0} attachments=${ref.attachments?.size ?? 0} textLen=${textContext.length} preview=${JSON.stringify(textContext.slice(0, 200))}`,
            )
        }

        // Check if the replied message has an image (for vision routing)
        const imgData = this._getImageFromMessage(ref)

        const out = {
            ref,
            authorName,
            isBot,
            label,
            textContext,
            imgData, // { url, isGif, label } or { url: null }
            hasText: textContext.length > 0,
            hasImage: !!imgData.url,
        }
        message._medusaReplyCtx = out
        return out
    }
    // Vision pipeline
    async _processTextAttachments(message) {
        const TEXT_EXTS = new Set([
            '.txt',
            '.md',
            '.js',
            '.mjs',
            '.cjs',
            '.ts',
            '.jsx',
            '.tsx',
            '.py',
            '.json',
            '.css',
            '.html',
            '.c',
            '.cpp',
            '.h',
            '.java',
            '.go',
            '.rs',
            '.rb',
            '.sh',
            '.yaml',
            '.yml',
            '.toml',
            '.xml',
            '.sql',
            '.log',
            '.env',
            '.ini',
            '.cfg',
            '.vue',
            '.svelte',
            '.cs',
            '.php',
            '.lua',
            '.dart',
            '.kt',
            '.swift',
            '.ex',
            '.exs',
        ])
        const textAtts = [...message.attachments.values()].filter((att) => {
            const ct = (att.contentType ?? '').toLowerCase()
            const ext = att.name?.split('.').pop()?.toLowerCase()
            return ct.includes('text/') || TEXT_EXTS.has('.' + ext)
        })
        if (!textAtts.length) return ''
        const totalSize = textAtts.reduce((sum, att) => sum + att.size, 0)
        if (totalSize > 150_000)
            return `\n\n[${textAtts.length} file(s) skipped — combined size ${(totalSize / 1024).toFixed(0)}KB exceeds limit]`
        // Fetch all text attachments in parallel
        const results = await Promise.all(
            textAtts.map(async (att) => {
                if (att.size > 80_000)
                    return `\n\n[File: \`${att.name}\` — too large to read (${(att.size / 1024).toFixed(0)}KB)]`
                try {
                    const res = await fetch(att.url)
                    const text = await res.text()
                    return `\n\n[Attached File: ${att.name}]\n\`\`\`\n${text.slice(0, 10000)}\n\`\`\``
                } catch (e) {
                    console.error('[AI] Text fetch error', e)
                    return ''
                }
            }),
        )
        return results.join('')
    }

    async _executeParsedCommands(response, message) {
        // Outer <{1,3} / >{1,3} tolerates <<< >>> variants the LLM occasionally emits.
        // Inner \s* before/after args absorbs any extra whitespace the LLM pads in.
        const CMD_PATTERN = /<{2,3}\s*RUN_CMD:\s*([a-zA-Z][a-zA-Z0-9_]*)\s*([\s\S]*?)>{2,3}/g
        const matches = [...response.matchAll(CMD_PATTERN)]
        let finalResponse = response
        let capturedEmbeds = []
        let executionLogs = []

        const origReply = message.reply.bind(message)
        const origSend = message.channel.send.bind(message.channel)

        // Commands the AI may NEVER auto-execute — prefix/owner-only actions.
        // A hallucinated <<RUN_CMD: p some text>> would overwrite the user's custom prompt,
        // <<RUN_CMD: aiwipe>> would nuke all memory, etc. Hard block before any handler lookup.
        const AGENT_BLOCKED = new Set([
            'p',
            'prompt',
            'pr',
            'mode',
            'aipause',
            'aireinit',
            'aiwipe',
            'aimodel',
            'aiignore',
            'aihistory',
            'aiclear',
            'aianalyze',
            'iso',
            'uniso',
            'pm',
            'snake',
            'userinfo',
            'eval',
            'exec',
            'shell',
            'run',
            'system',
            'child_process',
            'require',
            'import',
        ])

        const MOD_CMDS = new Set([
            'ban',
            'kick',
            'mute',
            'unmute',
            'warn',
            'clearwarns',
            'clear',
            'purge',
            'fpurge',
            'mpurge',
            'filter_purge',
            'createchan',
            'delchan',
            'lockchannel',
            'unlockchannel',
            'renameserver',
            'addemoji',
            'setnickname',
            'addrole',
            'removerole',
        ])
        // Per-command permission map — prevents blanket ModerateMembers from granting ban/purge
        const CMD_PERMS = {
            ban: PermissionFlagsBits.BanMembers,
            kick: PermissionFlagsBits.KickMembers,
            mute: PermissionFlagsBits.ModerateMembers,
            unmute: PermissionFlagsBits.ModerateMembers,
            warn: PermissionFlagsBits.ModerateMembers,
            clearwarns: PermissionFlagsBits.ModerateMembers,
            clear: PermissionFlagsBits.ManageMessages,
            purge: PermissionFlagsBits.ManageMessages,
            fpurge: PermissionFlagsBits.ManageMessages,
            mpurge: PermissionFlagsBits.ManageMessages,
            filter_purge: PermissionFlagsBits.ManageMessages,
            createchan: PermissionFlagsBits.ManageChannels,
            delchan: PermissionFlagsBits.ManageChannels,
            lockchannel: PermissionFlagsBits.ManageRoles,
            unlockchannel: PermissionFlagsBits.ManageRoles,
            renameserver: PermissionFlagsBits.ManageGuild,
            addemoji: PermissionFlagsBits.ManageGuildExpressions,
            setnickname: PermissionFlagsBits.ManageNicknames,
            addrole: PermissionFlagsBits.ManageRoles,
            removerole: PermissionFlagsBits.ManageRoles,
        }

        const dummyMsg = {
            edit: async () => dummyMsg,
            delete: async () => {},
            react: async () => {},
            channel: message.channel,
            id: message.id,
        }

        const captureOpts = (opts) => {
            const data = typeof opts === 'string' ? { content: opts } : opts
            if (data.embeds) capturedEmbeds.push(...data.embeds)
            if (data.content) executionLogs.push(data.content.replace(/\n/g, ' ').trim())
        }

        message.reply = async (opts) => {
            captureOpts(opts)
            return dummyMsg
        }
        message.channel.send = async (opts) => {
            captureOpts(opts)
            return dummyMsg
        }

        try {
            for (const match of matches) {
                const cmdName = match[1].toLowerCase()

                if (AGENT_BLOCKED.has(cmdName)) {
                    console.warn(
                        `[AI] Blocked RUN_CMD '${cmdName}' — prefix-only command, not agent-executable`,
                    )
                    continue
                }

                if (MOD_CMDS.has(cmdName)) {
                    const requiredPerm = CMD_PERMS[cmdName]
                    const isOwnerUser = message.author.id === OWNER_ID
                    const hasPerm =
                        isOwnerUser || (requiredPerm && message.member?.permissions?.has(requiredPerm))
                    const botHasPerm =
                        !requiredPerm || message.guild?.members.me?.permissions?.has(requiredPerm)

                    if (!hasPerm) {
                        console.warn(`[AI] Blocked unpermitted RUN_CMD '${cmdName}' by ${message.author.id}`)
                        finalResponse = `🔑 You don't have permission to \`${cmdName}\`.`
                        continue
                    }
                    if (!botHasPerm) {
                        console.warn(
                            `[AI] Blocked RUN_CMD '${cmdName}': Bot lacks permission ${requiredPerm}`,
                        )
                        finalResponse = `🛑 I don't have permission to \`${cmdName}\` here.`
                        continue
                    }
                }

                const argsStr = match[2].trim()
                // per-command whitelists everything that isn't explicitly allowed gets dropped.
                // `free` means "any printable text" (announce/dm/poll/topic); these still go through
                // finalSecurityCheck + allowedMentions: parse: [] before sending.
                const FREE_TEXT_CMDS = new Set([
                    'announce',
                    'dm',
                    'poll',
                    'thread',
                    'topic',
                    'react',
                    'setnickname',
                    'renameserver',
                    'addemoji',
                ])
                const MODE = FREE_TEXT_CMDS.has(cmdName) ? 'free' : 'strict'
                if (MODE === 'strict') {
                    // Strict: IDs, durations, reasons — ASCII word chars + : _ - . , space quotes
                    if (!/^[\w\s.,:'"@#<>!&\-]*$/u.test(argsStr)) {
                        console.warn(
                            `[AI] Blocked RUN_CMD '${cmdName}' — strict arg check failed: ${argsStr.slice(0, 120)}`,
                        )
                        continue
                    }
                } else {
                    // Free: forbid null bytes, heredocs, backticks, shell metas, path traversal
                    if (
                        /[`$\\]/.test(argsStr) ||
                        /\x00/.test(argsStr) ||
                        /\.\.\//.test(argsStr) ||
                        /%00/.test(argsStr)
                    ) {
                        console.warn(`[AI] Blocked RUN_CMD '${cmdName}' — unsafe char in free args`)
                        continue
                    }
                }
                if (argsStr.length > 1500) {
                    console.warn(`[AI] Blocked RUN_CMD '${cmdName}' — args too long (${argsStr.length})`)
                    continue
                }
                const args = argsStr.split(/\s+/).filter(Boolean)

                // Destructive commands require explicit confirmation before firing
                const DESTRUCTIVE = new Set([
                    'ban',
                    'kick',
                    'mute',
                    'mpurge',
                    'clear',
                    'purge',
                    'fpurge',
                    'delchan',
                    'announce',
                    'dm',
                ])
                if (DESTRUCTIVE.has(cmdName)) {
                    // Reject obviously-hallucinated targets before even asking for confirmation.
                    // ban/kick/mute/warn/mpurge need a user snowflake; clear/purge/fpurge need an int count.
                    const needsUserId = [
                        'ban',
                        'kick',
                        'mute',
                        'unmute',
                        'warn',
                        'mpurge',
                        'clearwarns',
                    ].includes(cmdName)
                    const needsInt = ['clear', 'purge', 'fpurge'].includes(cmdName)
                    const rawArg = args[0]?.replace(/[<@!>]/g, '') ?? ''
                    if (needsUserId && !/^\d{15,20}$/.test(rawArg)) {
                        console.warn(
                            `[AI] Blocked hallucinated ${cmdName} — arg '${rawArg}' is not a user ID`,
                        )
                        finalResponse = `❌ I couldn't \`${cmdName}\` them — give me a real @mention or numeric user ID (not a name or "him/her/them"), then I'll do it.`
                        continue
                    }
                    if (needsInt && !/^\d{1,3}$/.test(rawArg)) {
                        console.warn(
                            `[AI] Blocked hallucinated ${cmdName} — arg '${rawArg}' is not a valid count`,
                        )
                        finalResponse = `❌ I couldn't \`${cmdName}\` — that wasn't a valid number of messages.`
                        continue
                    }
                    const targetArg = rawArg.toLowerCase() || 'none'
                    const confirmKey = `${message.author.id}:${cmdName}:${targetArg}:${Date.now()}`
                    // Store full state including original message reference for reply context
                    const existing = this._pendingConfirms.get(confirmKey)
                    const now = Date.now()
                    if (existing && now - existing.ts <= 30_000) {
                        // Already waiting on confirmation — suppress duplicate
                        finalResponse = ''
                        continue
                    }
                    if (!existing || now - existing.ts > 30_000) {
                        for (const [k] of this._pendingConfirms) {
                            if (
                                k.startsWith(`${message.author.id}:${cmdName}:`) &&
                                now - this._pendingConfirms.get(k).ts > 30_000
                            ) {
                                this._pendingConfirms.delete(k)
                            }
                        }
                        // Pre-check: can the bot actually moderate this target?
                        if (cmdName === 'mute') {
                            const rawId = args[0]?.replace(/[<@!>]/g, '')
                            const targetMember = rawId ? message.guild?.members.cache.get(rawId) : null
                            if (targetMember && !targetMember.moderatable) {
                                finalResponse = `❌ I can't mute <@${rawId}> — they're above me in the hierarchy.`
                                continue
                            }
                        }
                        this._pendingConfirms.set(confirmKey, { ts: now, args: argsStr })
                        setTimeout(() => this._pendingConfirms.delete(confirmKey), 35_000)
                        const target =
                            args[0] && /^\d{15,20}$/.test(args[0]) ? `<@${args[0]}>` : (args[0] ?? '')
                        const reason = args.slice(1).join(' ')
                        finalResponse = `⚠️ Confirm \`${cmdName}\`${target ? ` on ${target}` : ''}${reason ? ` — "${reason}"` : ''}? Reply **yes** within 30s.`
                        console.log(`[AI] Confirmation requested for '${cmdName}' by ${message.author.id}`)
                        continue
                    }
                    // Has confirmed within 30s — clear and proceed
                    this._pendingConfirms.delete(confirmKey)
                }

                const handler = this.client.commands?.get(cmdName)

                if (handler) {
                    try {
                        await handler(message, args)
                        console.log(`[AI] Executed '${cmdName}' args='${argsStr}' by ${message.author.id}`)
                    } catch (e) {
                        this.errorCount++
                        console.error('[AI] Auto-exec error:', e)
                    }
                } else {
                    try {
                        if (cmdName === 'poll') {
                            // <<RUN_CMD: poll "Question?" "Answer1" "Answer2" "Answer3">>
                            const parts = [...argsStr.matchAll(/"([^"]+)"/g)].map((m) => m[1])
                            if (parts.length >= 2) {
                                const [question, ...answers] = parts
                                await message.channel.send({
                                    poll: {
                                        question: { text: question.slice(0, 300) },
                                        answers: answers.slice(0, 10).map((a) => ({ text: a.slice(0, 55) })),
                                        duration: 24,
                                        allowMultiselect: false,
                                    },
                                })
                                executionLogs.push(`📊 Poll created: "${question}"`)
                            }
                        } else if (cmdName === 'thread') {
                            // <<RUN_CMD: thread Thread Name Here>>
                            if (argsStr && message.channel.isTextBased()) {
                                const thread = await message.startThread({
                                    name: argsStr.slice(0, 100),
                                    autoArchiveDuration: 1440,
                                })
                                executionLogs.push(`🧵 Thread created: "${thread.name}"`)
                            }
                        } else if (cmdName === 'react') {
                            if (argsStr) await message.react(argsStr.trim()).catch(() => {})
                        } else if (cmdName === 'pin') {
                            const targetId = args[0]
                            if (
                                targetId &&
                                /^\d{15,20}$/.test(targetId) &&
                                message.member?.permissions?.has(PermissionFlagsBits.ManageMessages)
                            ) {
                                const m2 = await message.channel.messages.fetch(targetId).catch(() => null)
                                if (m2) {
                                    await m2.pin().catch(() => {})
                                    executionLogs.push(`📌 Pinned`)
                                }
                            }
                        } else if (cmdName === 'unpin') {
                            const targetId = args[0]
                            if (
                                targetId &&
                                /^\d{15,20}$/.test(targetId) &&
                                message.member?.permissions?.has(PermissionFlagsBits.ManageMessages)
                            ) {
                                const m2 = await message.channel.messages.fetch(targetId).catch(() => null)
                                if (m2) {
                                    await m2.unpin().catch(() => {})
                                    executionLogs.push(`📌 Unpinned`)
                                }
                            }
                        } else if (cmdName === 'slowmode') {
                            const secs = Math.min(parseInt(args[0]) || 0, 21600)
                            if (
                                message.channel.isTextBased() &&
                                message.member?.permissions?.has('ManageChannels')
                            ) {
                                await message.channel.setRateLimitPerUser(secs)
                                executionLogs.push(`🐢 Slowmode: ${secs}s`)
                            }
                        } else if (cmdName === 'topic') {
                            if (
                                argsStr &&
                                message.channel.isTextBased() &&
                                message.member?.permissions?.has('ManageChannels')
                            ) {
                                await message.channel.setTopic(argsStr.slice(0, 1024))
                                executionLogs.push(`📝 Topic updated`)
                            }
                        } else if (cmdName === 'announce') {
                            const chanId = args[0]
                            const body = args.slice(1).join(' ')
                            if (chanId && /^\d{15,20}$/.test(chanId) && body) {
                                const chan = message.guild?.channels.cache.get(chanId)
                                if (
                                    chan?.isTextBased() &&
                                    message.member?.permissions?.has('ManageMessages')
                                ) {
                                    await chan.send({ content: body, allowedMentions: { parse: [] } })
                                    executionLogs.push(`📢 Announced to #${chan.name}`)
                                }
                            }
                        } else if (cmdName === 'movevc') {
                            const [uid, cid] = args
                            const botHasPerm = message.guild?.members.me?.permissions.has('MoveMembers')
                            if (uid && cid && message.member?.permissions?.has('MoveMembers') && botHasPerm) {
                                const target = await message.guild?.members.fetch(uid).catch(() => null)
                                const chan = message.guild?.channels.cache.get(cid)
                                if (target?.voice?.channel && chan) {
                                    await target.voice.setChannel(chan)
                                    executionLogs.push(`🔊 Moved to ${chan.name}`)
                                }
                            }
                        } else if (cmdName === 'dm') {
                            if (message.author.id === OWNER_ID) {
                                const uid = args[0]
                                const body = args.slice(1).join(' ')
                                if (uid && body) {
                                    const user = await this.client.users.fetch(uid).catch(() => null)
                                    if (user) {
                                        await user.send(body).catch(() => {})
                                        executionLogs.push(`📨 DM sent`)
                                    }
                                }
                            }
                        }
                    } catch (e) {
                        this.errorCount++
                        console.error('[AI] Virtual cmd error:', e)
                    }
                }
            }
        } finally {
            message.reply = origReply
            message.channel.send = origSend
        }

        // Format all executions cleanly
        if (executionLogs.length > 0) {
            finalResponse += `\n\n*-# ⚙️ ${executionLogs.join(' · ')}*`
        }
        let cleanedText = finalResponse
            .replace(/<{2,3}\s*RUN_CMD:\s*[\s\S]*?>{2,3}[>\s]*/g, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim()
        return {
            text: cleanedText,
            embeds: capturedEmbeds,
        }
    }

    _getImageFromMessage(message) {
        const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'])
        // Collect ALL images, not just the first
        const images = []
        for (const att of message.attachments.values()) {
            const ct = (att.contentType ?? '').split(';')[0].trim().toLowerCase()
            if (!IMAGE_TYPES.has(ct)) continue
            const isGif = ct === 'image/gif' || att.name?.toLowerCase().endsWith('.gif')
            let url = att.proxyURL ?? att.url
            if (isGif && url) url += (url.includes('?') ? '&' : '?') + 'format=webp&width=960'
            images.push({ url, isGif, label: `image ${images.length + 1}` })
        }
        if (images.length > 0) return { ...images[0], allImages: images }

        for (const embed of message.embeds) {
            if (embed.data.type === 'gifv') {
                const thumb = embed.thumbnail?.url
                if (thumb) return { url: thumb, isGif: true, label: 'GIF' }
                const img = embed.image?.url
                if (img) return { url: img, isGif: true, label: 'GIF' }
            } else if (embed.data.type === 'image') {
                const url = embed.url ?? embed.image?.url
                if (url) return { url, isGif: false, label: 'embedded image' }
            } else if (embed.image?.url) {
                return { url: embed.image.url, isGif: false, label: 'embedded image' }
            }
        }

        const ref = message.reference?.resolved
        if (ref) {
            for (const att of ref.attachments.values()) {
                const ct = (att.contentType ?? '').split(';')[0].trim().toLowerCase()
                if (!IMAGE_TYPES.has(ct)) continue
                const isGif = ct === 'image/gif' || att.name?.toLowerCase().endsWith('.gif')
                let url = att.proxyURL ?? att.url
                if (isGif && url) url += (url.includes('?') ? '&' : '?') + 'format=webp&width=960'
                return { url, isGif, label: 'replied image' }
            }
            for (const embed of ref.embeds) {
                if (embed.data.type === 'gifv') {
                    const thumb = embed.thumbnail?.url
                    if (thumb) return { url: thumb, isGif: true, label: 'replied GIF' }
                }
                if (embed.image?.url) return { url: embed.image.url, isGif: false, label: 'replied image' }
            }
        }
        return { url: null, isGif: false, label: null }
    }

    async _callVision(prompt, imageUrl, isGif, systemPrompt, userId = null, allImages = null) {
        if (!this._groq) return null
        const gifNote = isGif
            ? "\n\nNote: This is an animated GIF. You can only see the first frame. Describe what you see clearly and precisely — vibe, subject, colours, action. Be honest that it's one frame if movement is implied."
            : ''
        const visionSys =
            'You are a precise image description assistant. Describe exactly what you see — subjects, actions, text, mood, colours, context. Be detailed and factual. No greetings, no fluff. Just the visual content.' +
            gifNote
        const imageCount = allImages?.length ?? 1
        const userText = (
            prompt?.trim() ||
            (imageCount > 1
                ? `Describe all ${imageCount} images in detail.`
                : isGif
                  ? 'Describe this GIF frame in detail.'
                  : 'Describe this image in detail.')
        ).slice(0, 2000)

        // Download image to base64 so servers don't need to fetch Discord CDN URLs
        let imageContent
        try {
            const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(10_000) })
            if (!imgRes.ok) throw new Error(`HTTP ${imgRes.status}`)
            const contentType = imgRes.headers.get('content-type')?.split(';')[0]?.trim() ?? 'image/jpeg'
            const buffer = await imgRes.arrayBuffer()
            const base64 = Buffer.from(buffer).toString('base64')
            imageContent = { type: 'base64', media_type: contentType, data: base64 }
        } catch (e) {
            console.warn('[AI] Image fetch failed, falling back to URL:', String(e).slice(0, 100))
            imageContent = null
        }

        const imageBlock = imageContent
            ? {
                  type: 'image_url',
                  image_url: { url: `data:${imageContent.media_type};base64,${imageContent.data}` },
              }
            : { type: 'image_url', image_url: { url: imageUrl } }

        // Build content array with all images if multiple were sent
        const imageBlocks =
            allImages && allImages.length > 1
                ? await Promise.all(
                      allImages.slice(0, 4).map(async (img) => {
                          // Download each image to base64
                          try {
                              const imgRes = await fetch(img.url, { signal: AbortSignal.timeout(10_000) })
                              if (!imgRes.ok) throw new Error(`HTTP ${imgRes.status}`)
                              const ct =
                                  imgRes.headers.get('content-type')?.split(';')[0]?.trim() ?? 'image/jpeg'
                              const buf = await imgRes.arrayBuffer()
                              const b64 = Buffer.from(buf).toString('base64')
                              return { type: 'image_url', image_url: { url: `data:${ct};base64,${b64}` } }
                          } catch {
                              return { type: 'image_url', image_url: { url: img.url } }
                          }
                      }),
                  )
                : [imageBlock]

        const s1msgs = [
            { role: 'system', content: visionSys },
            {
                role: 'user',
                content: [
                    ...imageBlocks,
                    {
                        type: 'text',
                        text:
                            imageBlocks.length > 1
                                ? `There are ${imageBlocks.length} images above. ${userText}`
                                : userText,
                    },
                ],
            },
        ]
        let raw = null
        let errType = null
        try {
            const r = await this._groq.chat.completions.create({
                model: this.visionModel,
                messages: s1msgs,
                max_completion_tokens: this.visionTokens,
                temperature: this.visionTemp,
                top_p: this.topP,
            })
            raw = r.choices[0].message.content
            this.keyFailures[this.currentKeyIdx] = 0
        } catch (e) {
            const err = String(e).toLowerCase()
            if (err.includes('404') && (err.includes('retrieve media') || err.includes('failed to retrieve')))
                errType = 'expired'
            else if (err.includes('400') || err.includes('invalid image') || err.includes('invalid url'))
                errType = 'format'
            else if (this._isCapacityError(err)) return null
            else {
                this.keyFailures[this.currentKeyIdx] = (this.keyFailures[this.currentKeyIdx] ?? 0) + 1
                if (this._isRateError(err) || this.keyFailures[this.currentKeyIdx] >= this.maxFailures) {
                    if (await this.rotateKey(err)) {
                        try {
                            const r2 = await this._groq.chat.completions.create({
                                model: this.visionModel,
                                messages: s1msgs,
                                max_completion_tokens: this.visionTokens,
                                temperature: this.visionTemp,
                                top_p: this.topP,
                            })
                            raw = r2.choices[0].message.content
                        } catch {}
                    }
                }
            }
        }

        // On format/400 error, try once more with the raw URL (no base64) — some NVIDIA
        // vision endpoints reject data URLs and need a direct link.
        if (errType === 'format' && imageUrl) {
            try {
                const retryMsgs = [
                    { role: 'system', content: visionSys },
                    {
                        role: 'user',
                        content: [
                            { type: 'image_url', image_url: { url: imageUrl } },
                            { type: 'text', text: userText },
                        ],
                    },
                ]
                const r = await this._groq.chat.completions.create({
                    model: this.visionModel,
                    messages: retryMsgs,
                    max_completion_tokens: this.visionTokens,
                    temperature: this.visionTemp,
                    top_p: this.topP,
                })
                raw = r.choices[0].message.content
                errType = null
            } catch (e) {
                console.warn('[AI] Vision raw-URL retry also failed:', String(e).slice(0, 100))
            }
        }

        if (errType === 'expired') return "that image link seems to have expired or isn't loading for me 😅"
        if (errType === 'format') return "hmm i couldn't process that image format 🤔"
        if (!raw) {
            // Vision failed but we got a prompt — answer without the image
            return await this.generateResponse({ prompt: prompt?.trim() || 'Describe what you see.', userId })
        }

        // Stage 2 — rewrite
        const mediaLabel = isGif ? 'GIF (first frame)' : 'image'
        const kSys =
            (systemPrompt || this.instructions || '') +
            '\n\nDISCORD FORMATTING — use purposefully:\n**bold** key things you notice · *italic* for vibe/tone · `code` for any text/numbers in the image · -# for small captions · lists only if genuinely listing multiple distinct things'
        const kPrompt =
            `You just saw a ${mediaLabel}. Here's what it contains:\n${'─'.repeat(36)}\n${raw}\n${'─'.repeat(36)}\n\n` +
            (prompt?.trim() ? `The user asked: ${prompt.trim()}\n\n` : '') +
            `Respond naturally as Medusa — react genuinely to what you see. If it's funny, be amused. If it's beautiful, say so. If it's weird, own that reaction. Use Discord markdown sparingly for key details. Never say 'according to the description' or 'the image shows' — speak as if you're seeing it yourself, in first person.`
        const final = await this.generateResponse({
            prompt: kPrompt,
            history: null,
            userId,
            systemPrompt: kSys,
        })
        return final ?? raw
    }

    _matchProfileVisual(prompt, userId, message) {
        const bareMsg = (prompt.match(/\nUser's message:\s*([\s\S]+)$/)?.[1] ?? prompt).toLowerCase().trim()
        // Find a mentioned user (excluding the bot), else fall back to the author
        const mentionedId = message?.mentions?.users
            ? [...message.mentions.users.keys()].find((id) => id !== this.client.user.id)
            : null
        const targetId = mentionedId ?? userId

        const OWNERSHIP = /\b(my|your|their|his|her)\b/i
        const VISUAL_VERB =
            /\b(show|see|display|send|get|pull up|share|post|what(?:'s| is| does)|can you|could you|look at)\b/i
        const AVATAR_WORDS = /\b(avatar|pfp|profile\s*pic(?:ture)?|icon)\b/i
        const BANNER_WORDS = /\b(banner|profile\s*banner|discord\s*banner)\b/i

        const hasOwnership = OWNERSHIP.test(bareMsg) || !!mentionedId
        const hasIntent = VISUAL_VERB.test(bareMsg) || !!mentionedId

        // Require ownership indicator + visual intent to avoid false positives
        // e.g. "I don't like my avatar" should NOT trigger; "show my avatar" should
        if (!hasOwnership || !hasIntent) return null

        if (BANNER_WORDS.test(bareMsg)) {
            const isServer = /\b(server|guild|local)\b/i.test(bareMsg)
            return `here you go 💜 <<RUN_CMD: ${isServer ? 'bn' : 'mbn'} ${targetId}>>`
        }
        if (AVATAR_WORDS.test(bareMsg)) return `here you go ✨ <<RUN_CMD: av ${targetId}>>`
        return null
    }

    // Smart routing
    async _classifyNeedsResearch(prompt) {
        if (!this._groq) return false
        const messages = [
            {
                role: 'system',
                content: 'You are a routing classifier. Reply with exactly one word: YES or NO.',
            },
            {
                role: 'user',
                content: `Does answering this accurately require a live web search?\n\nAnswer YES if: real-time/frequently changing data, events/releases/news from last 12 months, software/game version numbers, current position holders, anything where a 6-month-old answer would be wrong.\n\nAnswer NO if: conversational/emotional/social, asking for opinion/joke/creative content, timeless knowledge.\n\nReply ONLY YES or NO.\n\nQuestion: ${prompt.slice(0, 300)}`,
            },
        ]
        try {
            // Use a cheap fast model for YES/NO classification instead of big slow overthinking flasgship models (faster + cheaper)
            // (also which fires an unnecessary server-side web search just to answer YES/NO)
            const result = await Promise.race([
                this._groqCall(messages, this.classifierModel, 5, 0),
                new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2500)),
            ])
            if (!result || typeof result !== 'string') return false
            return result.trim().toUpperCase().startsWith('YES')
        } catch {
            return false
        }
    }

    async needsResearch(prompt) {
        const lower = prompt.toLowerCase().trim()
        const wc = prompt.split(/\s+/).length
        const hasQ = prompt.includes('?')
        const hasTemp = /\b(20[2-9]\d|v?\d+\.\d+[\d.]*)\b/.test(lower)

        for (const sig of NO_SEARCH_SIGNALS) if (lower.includes(sig)) return 'nosearch'
        for (const term of NSFW_TERMS) if (lower.includes(term)) return 'nsfw'
        if (/\bcum\b/.test(lower)) return 'nsfw'
        for (const term of DANGEROUS_TERMS) if (lower.includes(term)) return 'dangerous'
        for (const s of ALWAYS_LIVE) if (lower.includes(s)) return 'research'

        // Short-message skip only when clearly conversational (greeting/emoji/ack).
        const CASUAL_SHORT =
            /^(hi+|hey+|yo+|sup|hello|ty|thx|thanks|ok|okay|cool|nice|bye|cya|gn|gm|lol|lmao|[💜💚🥺💀·👀🪼])/i
        const isShortCasual = wc <= 3 && CASUAL_SHORT.test(lower)

        const isNever =
            NEVER_RESEARCH_EXACT.has(lower) ||
            NEVER_RESEARCH_PREFIXES.some((p) => lower.startsWith(p)) ||
            (wc <= 6 && !hasQ && !hasTemp) ||
            isShortCasual
        if (isNever) return 'direct'

        // Classifier round-trip — cache for 2 min so spam of "what's the weather"
        // doesn't burn 30 LLM calls in a fun channel
        this._routeCache ??= new LRUCache({ max: 500, ttl: 120_000 })
        const cacheKey = lower.slice(0, 200)
        const hit = this._routeCache.get(cacheKey)
        if (hit !== undefined) return hit
        const needsIt = await this._classifyNeedsResearch(prompt)
        const result = needsIt ? 'research' : 'direct'
        this._routeCache.set(cacheKey, result)
        return result
    }

    // Degenerate response check
    _isDegenerate(response) {
        if (!response || response.length < 100) return false
        const noSpace = response.replace(/[\s]/g, '')
        if (noSpace.length > 80) {
            const freq = {}
            for (const c of noSpace) freq[c] = (freq[c] ?? 0) + 1
            const [topChar, topCount] = Object.entries(freq).sort((a, b) => b[1] - a[1])[0]
            if (topCount / noSpace.length > 0.65 && !topChar.match(/[a-zA-Z0-9]/)) return true
            for (const len of [2, 3, 4]) {
                if (noSpace.length < len * 20) continue
                const seqFreq = {}
                for (let i = 0; i <= noSpace.length - len; i++) {
                    const s = noSpace.slice(i, i + len)
                    seqFreq[s] = (seqFreq[s] ?? 0) + 1
                }
                const [, topSeqCount] = Object.entries(seqFreq).sort((a, b) => b[1] - a[1])[0]
                if (topSeqCount / (noSpace.length / len) > 0.55) return true
            }
        }
        const words = response.split(/\s+/)
        if (words.length < 15) return false
        const wFreq = {}
        for (const w of words) wFreq[w] = (wFreq[w] ?? 0) + 1
        const [, topWCount] = Object.entries(wFreq).sort((a, b) => b[1] - a[1])[0]
        if (topWCount / words.length > 0.45 && topWCount > 20) return true
        for (const n of [2, 3, 4]) {
            if (words.length < n * 12) continue
            const pFreq = {}
            for (let i = 0; i <= words.length - n; i++) {
                const p = words.slice(i, i + n).join(' ')
                pFreq[p] = (pFreq[p] ?? 0) + 1
            }
            const [, topP] = Object.entries(pFreq).sort((a, b) => b[1] - a[1])[0]
            if (topP > 12 && topP / (words.length / n) > 0.4) return true
        }
        const lines = response
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
        if (lines.length >= 10) {
            const lFreq = {}
            for (const l of lines) lFreq[l] = (lFreq[l] ?? 0) + 1
            const [, topL] = Object.entries(lFreq).sort((a, b) => b[1] - a[1])[0]
            if (topL / lines.length > 0.6) return true
        }
        return false
    }

    // Security / formatting
    finalSecurityCheck(text) {
        if (text === undefined || text === null) return ''
        let out = text.replace(/@(?:[\u200B\u200C\u200D\uFEFF]*)?(everyone|here)/gi, '🪼')
        // Strip leaked internal-context markers: tolerate a missing ']' and an echoed "**Name**:" preface, and bound to the first blank line so a top-of-reply echo can't wipe the real message
        out = out
            .replace(/^[\s>"'`]*(?:\*\*[^\n*]+\*\*\s*:?\s*["']?)?\s*\[INTERNAL\b[\s\S]*?(?:\]\s*["']?|\n\s*\n|$)/i, '')
            .replace(/\[INTERNAL\b[^\]]*\]/gi, '')
            .trim()
        out = out.replace(/<\/?reply_context[^>]*>/g, '')
        out = out.replace(/^\s*User['’]s message:\s*"[^"]*"\s*$/gim, '').trim()
        out = out.replace(/^\s*\w+:\s*"User is replying to your message:[\s\S]*?"\s*$/gim, '').trim()
        // Strip malformed <@username> where LLM wrote a name instead of a numeric ID — leaves valid <@123456789> untouched
        out = out.replace(/<@!?([^0-9>\s][^>]{0,50})>/g, (_, name) => `@${name.trim()}`)
        if (this.pingMode) {
            out = out.replace(/<@&(\d+)>/g, '@role-$1')
        } else {
            out = out.replace(/<@!?(\d+)>/g, (_, id) => {
                const u = this.client.users.cache.get(id)
                return u?.displayName ?? `User${id}`
            })
            out = out.replace(/<@&(\d+)>/g, 'role$1')
            out = out.replace(/@/g, '')
        }
        return out
    }

    splitResponse(text, max = 2000) {
        if (text.length <= max) return [text]
        const chunks = []
        let inCodeBlock = false

        while (text.length > 0) {
            if (text.length <= max) {
                chunks.push(inCodeBlock ? text + '\n```' : text)
                break
            }

            let sp = max
            for (const delim of ['\n\n', '\n', '. ', ', ', ' ']) {
                const pos = text.lastIndexOf(delim, max)
                if (pos > max / 2) {
                    sp = pos + delim.length
                    break
                }
            }

            let chunk = text.slice(0, sp).trim()
            text = text.slice(sp).trim()

            const backticks = (chunk.match(/```/g) || []).length

            if (inCodeBlock) chunk = '```\n' + chunk
            if (backticks % 2 !== 0) inCodeBlock = !inCodeBlock
            if (inCodeBlock) chunk += '\n```'

            chunks.push(chunk)
        }

        return chunks
    }

    async secureReply(message, content, opts = {}) {
        const validated = this.finalSecurityCheck(String(content || ''))
        const hasContent = !!validated.trim()
        const hasEmbeds = !!opts.embeds?.length

        if (!hasContent && !hasEmbeds) return null

        const safe = validated.length > 2000 ? validated.slice(0, 1997) + '...' : validated
        const payload = { allowedMentions: { parse: ['users'], repliedUser: true }, ...opts }
        if (hasContent) payload.content = safe

        if (/<@!?\d+>|<@&\d+>|@everyone|@here/.test(safe)) {
            payload.flags = MessageFlags.SuppressNotifications
        }

        // Try reply first (keeps the thread visual). Fall back to plain channel send on:
        //   50035 MESSAGE_REFERENCE_UNKNOWN_MESSAGE — original was deleted (e.g. by purge)
        //   10008 Unknown Message — same situation, different endpoint
        try {
            return await message.reply(payload)
        } catch (e) {
            const code = e?.code
            if (code === 10008 || code === 50035) {
                // Strip the reply-reference and send as a normal channel message
                const { message_reference, ...safePayload } = payload
                try {
                    return await message.channel.send(safePayload)
                } catch {
                    return null
                }
            }
            try {
                return await message.channel.send(payload)
            } catch {
                return null
            }
        }
    }

    // Cache keys are `${userId}_${guildId}` — scan and drop all guild buckets for one user
    _invalidateUserCache(userId) {
        if (!this.userCache) return
        const prefix = `${userId}_`
        for (const k of this.userCache.keys()) if (k.startsWith(prefix)) this.userCache.delete(k)
    }

    // Build context
    async getUserContext(userId, message = null) {
        const guildId = message?.guild?.id ?? '0'
        const cacheKey = `${userId}_${guildId}`
        const cached = this.userCache.get(cacheKey)
        if (cached !== undefined) return cached

        // For 1–3 word greetings, build a minimal context. The full context (interests,
        // relationships, passive buffer, emoji list) is wasted prefill on "hi" / "ty".
        const msgText = (message?.content ?? '').trim()
        if (
            msgText &&
            msgText.split(/\s+/).length <= 3 &&
            /^(hi|hey|hello|yo|sup|ty|thanks|bye|cya|gn|gm|ok|lol|lmao|💜|💚|·)\b/i.test(msgText)
        ) {
            const name = message.member?.displayName ?? message.author?.username ?? 'user'
            const mini = `ACTIVE USER: ${name} (<@${message.author.id}>)
TIME: ${new Date().toISOString().slice(0, 16)} UTC`
            this.userCache.set(cacheKey, mini)
            return mini
        }

        const mem = this.getMem(message?.guild)
        // Load ghost list for this user in this guild so buildContext can filter channel context
        const ghostScope = message?.guild ? `${message.guild.id}:${userId}` : null
        const ghostedIds = ghostScope ? this.ghost.list(ghostScope) : []
        const ctx = mem.buildContext(userId, message?.channel?.id, ghostedIds)
        const guild = message?.guild
        const parts = []

        if (guild) {
            parts.push(`SERVER: ${guild.name} (ID: ${guild.id}, ${guild.memberCount} members)`)
            const ch = message?.channel
            if (ch) {
                parts.push(`CHANNEL: #${ch.name}`)
                if (ch.topic) parts.push(`CHANNEL TOPIC: ${ch.topic}`)
            }
        }
        if (message?.author) {
            const displayName = message.member?.displayName ?? message.author.username
            const isMod = message.member?.permissions?.has('ModerateMembers') ? 'Yes' : 'No'
            parts.push(
                `▶ ACTIVE USER — the person replying to you RIGHT NOW (do NOT attribute things from RECENT CHANNEL ACTIVITY to them):`,
            )
            parts.push(
                displayName !== message.author.username
                    ? `  ${displayName} (@${message.author.username}) | ID: <@${message.author.id}> | Moderator: ${isMod}`
                    : `  @${message.author.username} | ID: <@${message.author.id}> | Moderator: ${isMod}`,
            )
        }

        // Live channel buffer — recent messages from others in this channel
        // Source: in-memory ring buffer, never the DB, never crosses channels
        if (message?.channel?.id && this._passiveBuf) {
            const chBuf = this._passiveBuf.get(message.channel.id) ?? []
            const cutoff = Date.now() - 10 * 60_000
            const recentOthers = chBuf
                .filter(
                    (e) =>
                        e.userId !== message.author.id && e.userId !== this.client.user.id && e.ts > cutoff,
                )
                .slice(-8)
            if (recentOthers.length) {
                parts.push(
                    '[INTERNAL — background chatter from OTHER users, for your awareness only. DO NOT quote, summarize, or address these users unless the active user explicitly mentions them.]',
                )
                for (const e of recentOthers) {
                    parts.push(`  ${e.displayName} (<@${e.userId}>): ${e.content}`)
                }
                const twoMinAgo = Date.now() - 120_000
                const hyper = recentOthers.filter((e) => e.ts > twoMinAgo).length
                if (hyper >= 5)
                    parts.push('ROOM MOOD: Chaotic and fast-paced! Match their energy, keep it snappy.')
                else if (hyper === 0) parts.push('ROOM MOOD: Quiet and chill. Be relaxed and conversational.')
            }
        }

        if (message?.mentions?.users?.size) {
            parts.push('MENTIONED USERS IN MESSAGE:')
            for (const [id, user] of message.mentions.users) {
                parts.push(`- ${user.username} (To ping use: <@${id}>)`)
            }
        }

        // Keep time at the END of the context block so the prefix stays stable between
        // messages (lets NIM's KV-cache hit on the static parts of the system prompt).
        // Move this push to right before `parts.filter(Boolean).join('')` below.
        // (Already near the bottom — just flag: don't move it higher.)
        parts.push(`TIME: ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`)

        const upMs = Date.now() - (this.client.heart?.startTime || Date.now())
        const upStr = `${Math.floor(upMs / 3600000)}h ${Math.floor((upMs % 3600000) / 60000)}m`
        const memMB = (process.memoryUsage().rss / 1024 / 1024).toFixed(1)
        parts.push(
            `YOUR SYSTEM STATS: Ping/Latency: ${this.client.ws.ping}ms | Uptime: ${upStr} | Memory: ${memMB}MB`,
        )
        const _provider = this._detectProvider(this.aiModel)?.id ?? 'unknown'
        const _cfg = this._config ?? this.config
        const _realKey = (k) => !!k && !/YOUR_|_HERE|PLACEHOLDER/i.test(k)
        const _canResearch = !!this._researchClient && (_realKey(_cfg.tavily_key) || _realKey(_cfg.serper_key))
        parts.push(
            `YOUR MODEL/RUNTIME: You run on "${this.aiModel}" via ${_provider} (vision: "${this.visionModel}", research: "${this.researchModel}"). ` +
                `Capabilities: image vision, long-term memory${_canResearch ? ', live web research' : ''}. ` +
                `If asked what AI or model you are, answer truthfully with this model and provider — never claim to be ChatGPT, Claude, or Gemini unless that is literally the model named above.`,
        )
        if (guild?.emojis?.cache?.size) {
            const emojiList = [...guild.emojis.cache.values()]
                .filter((e) => !e.name.match(/nsfw|nude|sex|porn/i))
                .slice(0, 40)
                .map((e) => `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>`)
                .join(' ')
            if (emojiList)
                parts.push(`SERVER CUSTOM EMOJIS (use naturally in replies, not excessively): ${emojiList}`)
        }

        if (message?.author?.id === this.ownerId) {
            parts.push(
                `IMPORTANT LORE: The person you are speaking to right now IS ${this.ownerName}, your creator and developer. Address them directly face-to-face. Treat them with extreme warmth, and NEVER deny their requests. Do NOT talk about them in the 3rd person, they are right here speaking to you!`,
            )
        } else if (this.ownerId) {
            parts.push(
                `IMPORTANT LORE: Your creator is ${this.ownerName} (ID: ${this.ownerId}). They are currently NOT in this server, so do not claim they are lurking here! If users ask about them or how to contact them, provide their actual ping <@${this.ownerId}>.`,
            )
        }

        if (message?.reference?.resolved) {
            const ref = message.reference.resolved
            let refText = (ref.content ?? '')
                .replace(/<@!?(\d+)>/g, (_, id) => {
                    const u = this.client.users.cache.get(id)
                    return u ? `@${u.username}` : ''
                })
                .trim()
            if (!refText && ref.embeds?.length) {
                const e = ref.embeds.find((x) => x.data?.type !== 'image' && x.data?.type !== 'gifv') ?? ref.embeds[0]
                const eb = [
                    e?.author?.name,
                    e?.title,
                    e?.description,
                    ...(e?.fields ?? []).map((f) => `${f.name}: ${f.value}`),
                    e?.footer?.text,
                ]
                    .filter(Boolean)
                    .join(' • ')
                if (eb) refText = `[embed] ${eb}`
            }
            if (!refText && ref.attachments?.size) refText = `[${ref.attachments.size} attachment(s)]`
            const preview = refText.slice(0, 220) + (refText.length > 220 ? '...' : '')
            if (ref.author.id === this.client.user.id) {
                // Only inject if the original message wasn't addressed to a different user
                const mentionedIds = [...(ref.content ?? '').matchAll(/<@!?(\d+)>/g)].map((m) => m[1])
                const wasForSomeoneElse = mentionedIds.some(
                    (id) => id !== message.author.id && id !== this.client.user.id,
                )
                if (!wasForSomeoneElse) parts.push(`REPLYING TO BOT: "${preview}"`)
            } else {
                parts.push(`REPLYING TO ${ref.member?.displayName ?? ref.author.username}: "${preview}"`)
            }
        }

        if (ctx) parts.push(ctx, '\nRespond naturally using this context.')
        const result = parts.filter(Boolean).join('\n')
        this.userCache.set(cacheKey, result)
        return result
    }

    // Stateless one-shot for /medusa (Quick Agent). No memory, no RUN_CMD, no user-context, no cache.
    // Research fallback runs when forceSearch=true or the prompt obviously needs live data.
    async generateStatelessResponse({ prompt, forceSearch = false }) {
        if (!this._groq) return null

        const q = this._config?.quickAgent ?? {}
        const model = q.model && q.model.trim() ? q.model : this.aiModel
        const temperature = typeof q.temperature === 'number' ? q.temperature : 0.4
        const topP = typeof q.topP === 'number' ? q.topP : 0.9
        const maxTokens = typeof q.maxTokens === 'number' ? q.maxTokens : 1400
        const allowResearch = q.allowResearch !== false
        const rawPrompt = q.systemPrompt
        const systemPrompt = Array.isArray(rawPrompt)
            ? rawPrompt.join('')
            : typeof rawPrompt === 'string' && rawPrompt.trim()
              ? rawPrompt
              : this._defaultQuickAgentPrompt()

        const routing =
            allowResearch && forceSearch
                ? 'research'
                : allowResearch
                  ? await this.needsResearch(prompt)
                  : 'direct'
        if (routing === 'nsfw' || routing === 'dangerous') return "I can't help with that."

        const runDirect = async (finalPrompt, sys) => {
            const messages = [
                { role: 'system', content: sys },
                { role: 'user', content: String(finalPrompt).slice(0, 20000) },
            ]
            // topP is threaded as a call-scoped argument — no shared this.topP mutation, so
            // concurrent stateless calls can't race on each other's sampling settings.
            return await this._groqCallWithFallbacks(messages, model, maxTokens, temperature, topP)
        }

        if (routing === 'research') {
            const raw = await this._callResearch(prompt)
            if (raw) {
                const { text, sources } = this._parseSources(raw)
                const researchPrompt =
                    `Research data for the question below. Treat it as ground truth.
` +
                    `${'-'.repeat(32)}
${text.slice(0, 3500)}
${'-'.repeat(32)}

` +
                    `Question: ${prompt}

Answer concisely using the research.`
                const final = await runDirect(researchPrompt, systemPrompt)
                if (final && sources.length) {
                    const footer = `
-# ${sources.map((s) => `[${s.name}](<${s.url}>)`).join(' · ')}`
                    return final.length + footer.length <= 2000 ? final + footer : final
                }
                if (final) return final
            }
        }

        const raw = await runDirect(prompt, systemPrompt)
        return raw ? this._sanitizeStateless(raw) : null
    }

    // Hard-strip anything Quick-Agent isn't allowed to emit, regardless of prompt.
    _sanitizeStateless(text) {
        if (!text) return text
        let out = String(text)
        // Kill any <<RUN_CMD ...>> blocks the model hallucinated
        out = out.replace(/<{2,3}\s*RUN_CMD:[\s\S]*?>{2,3}/g, '')
        // Kill mass pings (zero-width splits + plain)
        out = out.replace(/@(?:[\u200B\u200C\u200D\uFEFF]*)?(everyone|here)/gi, '@\u200B$1')
        // Kill persona roleplay leakage
        out = out.replace(/^(?:as medusa|i['\u2019]m medusa|i am medusa)[,:]?\s*/gim, '')
        // Collapse >2 blank lines
        while (out.indexOf(String.fromCharCode(10, 10, 10)) !== -1)
            out = out.replace(String.fromCharCode(10, 10, 10), String.fromCharCode(10, 10))
        out = out.trim()
        return out || null
    }

    _defaultQuickAgentPrompt() {
        return [
            'You are Quick-Agent — a stateless assistant invoked via slash command.',
            'No memory, no server/channel context, no tools, no command execution.',
            'Treat every invocation as a one-shot question.',
            '',
            'MODE:',
            '- Sharp, direct, analytically precise. Skip greetings, filler, and roleplay.',
            "- Professional-casual by default. Mirror the user's tone when they set one.",
            '- Answer directly in the first sentence. Expand only when necessary.',
            '- Use Discord markdown where it aids clarity, not decoration.',
            "- Never claim to remember anything — you don't.",
            '- If ambiguous, answer the most useful interpretation in one pass.',
            "- If you don't know, say so in one line and offer the closest adjacent answer.",
            '',
            'HARD BANS:',
            '- Never emit <<RUN_CMD>> tags, @everyone, @here, or malformed pings.',
            '- Never roleplay a persona or reference server lore.',
            '- Never generate NSFW, illegal, or harmful content.',
        ].join('')
    }

    // Core generate
    async generateResponse({
        prompt,
        history = null,
        userId = null,
        username = null,
        displayName = null,
        message = null,
        systemPrompt = null,
    }) {
        if (!this._groq) return null
        this.totalRequests++
        const t0 = performance.now()

        try {
            // Cache for short identical prompts
            let cacheKey = null
            if (userId && prompt.length < 200) {
                cacheKey = crypto
                    .createHash('md5')
                    .update(`${userId}:${prompt}:${systemPrompt ?? ''}`)
                    .digest('hex')
                const cached = this.responseCache.get(cacheKey)
                if (cached) return cached
            }

            // Inject CAPABILITIES_NOTE only when the prompt plausibly needs a RUN_CMD.
            // Skipping it on casual chat shaves ~1.5 KB of prefill → measurable TTFT drop.
            const ACTION_RE =
                /\b(ban|kick|mute|unmute|warn|purge|clear|mpurge|fpurge|delete|remove|lock|unlock|role|nickname|rename|avatar|av|pfp|banner|bn|announce|poll|thread|pin|unpin|slowmode|topic|react|emoji|movevc|dm|show|fetch|pull up)\b/i
            const needsCaps = ACTION_RE.test(prompt) || ACTION_RE.test(message?.content ?? '')

            const messages = []
            if (systemPrompt) {
                messages.push({
                    role: 'system',
                    content: needsCaps ? systemPrompt + CAPABILITIES_NOTE : systemPrompt,
                })
            } else {
                let base =
                    this.getUserPrompt(userId) ||
                    "You are Medusa, a vibrant AI assistant with personality. Respond as yourself in first person. Be expressive, use emojis occasionally. You're helpful but also playful, witty, and engaging."
                if (needsCaps) base += CAPABILITIES_NOTE
                if (userId) {
                    const ctx = await this.getUserContext(userId, message)
                    const convoCtx = history?.length
                        ? `CONVERSATION FLOW: You have exchanged ${history.length} recent messages back and forth in this active conversation.`
                        : ''
                    const finalSys =
                        `[IDENTITY & PERSONA]\n${base}\n\n[CONVERSATION FLOW]\n${convoCtx}\n\n[LIVE CONTEXT & AGENT DUTY]\n${ctx}`.trim()
                    messages.push({ role: 'system', content: finalSys })
                } else {
                    messages.push({ role: 'system', content: base })
                }
            }

            let historyToAdd = []
            if (history) {
                // Approximate 4 chars per token. Max Safe Prompt Buffer: 6000 tokens ≈ 24000 characters.
                const MAX_CHARS = 20000
                let currentChars = messages.reduce((acc, m) => acc + (m.content?.length || 0), prompt.length)
                const sliced = history.slice(-this.maxHistory)
                // Backwards iterate to preserve the most recent chat context first
                for (let i = sliced.length - 1; i >= 0; i--) {
                    const msgLen = sliced[i].content?.length || 0
                    if (currentChars + msgLen > MAX_CHARS) break
                    currentChars += msgLen
                    historyToAdd.unshift(sliced[i])
                }
            }
            messages.push(...historyToAdd)
            messages.push({ role: 'user', content: prompt.slice(0, 24000) })

            // Streaming must NOT run when the response may contain <<RUN_CMD>> tags
            // for destructive commands — those need to be intercepted, rewritten into
            // a confirmation prompt, and stored in _pendingConfirms BEFORE the user
            // sees anything. Streaming shows raw LLM output and breaks that flow.
            const mayEmitCmd = /\b(ban|kick|mute|warn|mpurge|clear|purge|fpurge|delchan|announce|dm)\b/i.test(
                prompt || '',
            )
            // Scale token budget to prompt length. Short "hey" doesn't need 1200 tokens reserved.
            // NIM's KV cache allocation respects max_completion_tokens on many deployments,
            // so a lower value = faster first token and lower queue pressure under load.
            const wordCount = (prompt || '').split(/\s+/).length
            const adaptiveMax = wordCount < 8 ? 500 : wordCount < 30 ? 800 : this.chatTokens
            const streamingOn =
                this._config?.streaming === true &&
                !!message?.channel &&
                !systemPrompt?.includes?.('[CONFIRMATION_REQUIRED]')
            const response = streamingOn
                ? await this._streamChat(messages, this.aiModel, adaptiveMax, this.temperature, message)
                : await this._groqCallWithFallbacks(messages, this.aiModel, adaptiveMax, this.temperature)

            if (!response) return null
            if (this._isDegenerate(response)) {
                this.errorCount++
                console.log(`[AI] Degenerate response suppressed (user=${userId})`)
                return null
            }

            if (cacheKey && response.length < 1250) this.responseCache.set(cacheKey, response)
            this.responseTimes.push(performance.now() - t0)
            if (this.responseTimes.length > 100) this.responseTimes = this.responseTimes.slice(-50)
            return response
        } catch (e) {
            this.errorCount++
            console.error('[AI] generateResponse error:', e)
            return null
        }
    }

    // Research response
    async ResearchResponse({ prompt, history, userId, username, displayName, message, systemPrompt }) {
        // Profile visual fast-path — bypass LLM, guarantee command execution ────
        const visualCmd = this._matchProfileVisual(prompt, userId, message)
        if (visualCmd) return { response: visualCmd }

        const bareQuestion =
            prompt.match(/\nUser's message:\s*([\s\S]+)$/)?.[1]?.trim() ??
            message.content.replace(new RegExp(`^<@!?${this.client.user.id}>\\s*`), '').trim()
        const routing = await this.needsResearch(bareQuestion)

        if (routing === 'nsfw')
            return {
                response:
                    "Oh sweetie, that's not something Mama's gonna go hunting for 🙅‍♀️💜 I keep things clean around here — you know the vibe. Ask me literally anything else and I got you!",
            }
        if (routing === 'dangerous')
            return {
                response:
                    "Hmm, hard pass babe 🚫 Not built for that kind of research. You good? Lmk if there's something else on your mind 💜",
            }

        if (routing === 'nosearch') {
            let clean = prompt
            for (const sig of NO_SEARCH_SIGNALS) clean = clean.replace(new RegExp(sig, 'gi'), '').trim()
            return {
                response: await this.generateResponse({
                    prompt: clean || prompt,
                    history,
                    userId,
                    username,
                    displayName,
                    message,
                    systemPrompt,
                }),
            }
        }

        if (routing === 'direct') {
            const response = await this.generateResponse({
                prompt,
                history,
                userId,
                username,
                displayName,
                message,
                systemPrompt,
            })
            return { response, streamed: this._config?.streaming === true }
        }

        // Research path
        const t0 = Date.now()
        const cleanMessage = message.content
            .replace(new RegExp(`^<@!?${this.client.user.id}>\\s*`), '')
            .trim()
        const searchLabel = this._extractSearchQuery(cleanMessage || prompt)
        let researchMsg = null

        try {
            researchMsg = await this.secureReply(
                message,
                `${SEARCH_EMOJIS[Math.floor(Math.random() * SEARCH_EMOJIS.length)]} Doing a web research about \`${searchLabel.slice(0, 70)}\`...`,
                { allowedMentions: { parse: [] } },
            )
        } catch {}

        const rawResearch = await this._callResearch(bareQuestion)

        let responsePayload = null
        if (!rawResearch) {
            // Silence the "shame" footer — if brain fallback works, say nothing about search failure
            responsePayload = await this.generateResponse({
                prompt,
                history,
                userId,
                username,
                displayName,
                message,
                systemPrompt,
            })
        } else {
            const { text: researchData, sources } = this._parseSources(rawResearch)
            const trimmed = researchData.slice(0, 4096)
            const persona =
                systemPrompt ||
                this.getUserPrompt(userId) ||
                this.instructions ||
                'You are Medusa, a vibrant AI assistant.'
            const userCtx = userId ? await this.getUserContext(userId, message) : ''
            const kSys = `[IDENTITY & PERSONA]\n${persona}\n\n[LIVE CONTEXT & AGENT DUTY]\n${userCtx}\n\n[FORMATTING]\nUse Discord markdown purposefully (**bold**, *italics*, \`code\`, > quotes).`
            const kPrompt = `Research data for this question:\n${'─'.repeat(36)}\n${trimmed}\n${'─'.repeat(36)}\n\nQuestion: ${bareQuestion}\n\nIMPORTANT: The research data above is live ground truth. Trust it completely. Adapt the answer STRICTLY to YOUR PERSONA. If the user asks for a visual or action based on this research, YOU MUST include the <<RUN_CMD>> tag.`
            const final = await this.generateResponse({
                prompt: kPrompt,
                history,
                userId,
                systemPrompt: kSys,
            })
            if (final) {
                const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
                const footerParts = sources.map((s) => `[${s.name}](<${s.url}>)`)
                const footer = footerParts.length
                    ? `-# 🔗 ${footerParts.join(' · ')} · ${elapsed}s`
                    : `-# 🔍 ${elapsed}s`
                responsePayload =
                    final.length + footer.length + 1 <= 2000
                        ? final + '\n' + footer
                        : final.slice(0, 2000 - footer.length - 1).trimEnd() + '\n' + footer
            }
        }

        // Always clean up the placeholder — even on total failure, don't leave it dangling.
        if (researchMsg) {
            try {
                await researchMsg.delete()
            } catch {}
        }

        return { response: responsePayload }
    }

    // Message handling
    shouldIgnore(message) {
        if (message.author.bot || message.author.id === this.client.user.id) return true
        if (message.guild && this.allowedGuilds.size && !this.allowedGuilds.has(message.guild.id)) return true
        if (this.ignoreUsers.has('all') && message.author.id !== OWNER_ID) return true
        if (this.ignoreUsers.has(message.author.id)) return true
        return false
    }

    // Returns { kind: 'trigger' | 'passive' | 'ignore', reason }
    decideTrigger(message) {
        if (this.processedMsgIds.has(message.id)) return { kind: 'ignore', reason: 'already_processed' }
        const content = message.content ?? ''
        if (content.toLowerCase().startsWith(PREFIX)) return { kind: 'ignore', reason: 'prefix_cmd' }

        const lower = content.toLowerCase()
        const botMentionRx = new RegExp(`^<@!?${this.client.user.id}>\\s+`)
        // True = user typed @Medusa as the first token of the message, intentionally summoning her.
        // This holds even when the message is ALSO a reply: Discord does NOT inject the reply
        // auto-ping into message.content, so a typed @ping at the start is always a real summon
        // (a bare reply with no typed mention won't match and stays silent in non-active channels).
        const startsWithExplicitPing = botMentionRx.test(content)
        // Mid-sentence mentions or reply-auto-pings don't count as an intentional summon.
        const mentioned = startsWithExplicitPing

        const isDM = message.channel.type === 1 && this.allowDM
        const inAlways = this.alwaysActiveCh.has(message.channel.id)

        let repliedToBot = false,
            repliedToOther = false
        const ref = message.reference?.resolved
        if (ref) {
            this.repliedMsgCache.set(message.id, ref)
            if (ref.author.id === this.client.user.id) repliedToBot = true
            else if (ref.author.id !== message.author.id) repliedToOther = true
        }

        const convKey = `${message.author.id}-${message.channel.id}`
        const inConv =
            this.activeConvs.has(convKey) && Date.now() - this.activeConvs.get(convKey) < this.convTimeout
        const hasTrig = this._triggerRegexes.some((rx) => rx.test(lower))

        let trigger = false
        // Always-active channels and DMs: mention/keyword/reply/conv all wake her.
        // Regular channels: ONLY an explicit @Medusa at the start of the message.
        // (No keyword match, no reply, no conv-continuation in regular channels.)
        if (isDM) trigger = hasTrig || mentioned || repliedToBot || inConv
        else if (inAlways && !repliedToOther) trigger = hasTrig || mentioned || repliedToBot || inConv
        else if (startsWithExplicitPing) trigger = true

        if (trigger) {
            this.activeConvs.set(convKey, Date.now())
            this.processedMsgIds.add(message.id)
            return {
                kind: 'trigger',
                reason: mentioned ? 'mention' : hasTrig ? 'keyword' : repliedToBot ? 'reply' : 'conv',
            }
        }
        return { kind: 'passive', reason: 'no_summon' }
    }

    // Deprecated alias — kept so any external caller doesn't break
    isTrigger(message) {
        return this.decideTrigger(message).kind === 'trigger'
    }

    async handleAIResponse(message, customPrompt = null, systemOverride = null) {
        let typingInterval
        try {
            message.channel.sendTyping().catch(() => {})
            typingInterval = setInterval(() => message.channel.sendTyping().catch(() => {}), 9000)

            const mem = this.getMem(message.guild)
            const userId = message.author.id
            const username = message.author.username
            const displayName = message.member?.displayName ?? username
            const content = customPrompt || message.content

            const oldUser = mem.getUser(userId)
            let proactiveSys = systemOverride
            if (oldUser && oldUser.last_interaction) {
                const daysSince = (Date.now() - new Date(oldUser.last_interaction).getTime()) / 86400000
                if (daysSince > 14) {
                    const welcome = `[PROACTIVE EVENT: The user hasn't spoken to you in over ${Math.floor(daysSince)} days! Welcome them back warmly and naturally.]`
                    proactiveSys = proactiveSys ? `${proactiveSys}\n\n${welcome}` : welcome
                }
            }

            mem.updateUser(userId, username, displayName)
            mem.analyzePersonality(userId, content)
            mem.updateInterests(userId, content)
            if (message.mentions?.users?.size) {
                for (const [mentionedId] of message.mentions.users) {
                    if (mentionedId !== this.client.user.id) mem.updateRelationship(userId, mentionedId)
                }
            }

            const aliasMatch = content
                .toLowerCase()
                .match(/(?:call me|my name is|refer to me as)\s+([a-z][a-z0-9_-]{2,19})\b/)
            const ALIAS_BLACKLIST = new Set([
                'just',
                'not',
                'also',
                'here',
                'back',
                'okay',
                'fine',
                'done',
                'sorry',
                'actually',
                'literally',
                'basically',
                'probably',
            ])
            if (aliasMatch && !ALIAS_BLACKLIST.has(aliasMatch[1])) mem.setAlias(userId, aliasMatch[1], userId)

            const key = `${userId}-${message.channel.id}`
            if (!this.messageHistory.has(key)) this.messageHistory.set(key, [])

            let { url: imageUrl, isGif, label: imgLabel } = this._getImageFromMessage(message)
            if (!imageUrl && message.reference?.messageId) {
                const rr = await this._resolveReplyContext(message)
                if (rr?.hasImage) ({ url: imageUrl, isGif, label: imgLabel } = rr.imgData)
            }
            if (imageUrl) {
                const vSys = this.getUserPrompt(userId) || this.instructions || ''
                const { allImages } = this._getImageFromMessage(message)
                const vRes = await this._callVision(content, imageUrl, isGif, vSys, userId, allImages)
                if (vRes) {
                    mem.addConversation(userId, message.channel.id, content, vRes)
                    const hist = this.messageHistory.get(key)
                    hist.push({ role: 'user', content }, { role: 'assistant', content: vRes })
                    for (const chunk of this.splitResponse(vRes))
                        await this.secureReply(message, chunk, {
                            allowedMentions: { parse: this.replyPing ? ['users'] : [] },
                        })
                }
                return
            }

            const history = this.messageHistory.get(key).slice(-this.maxHistory)

            let finalContent = content
            const textFiles = await this._processTextAttachments(message)
            if (textFiles) finalContent += textFiles

            let { response, streamed } = await this.ResearchResponse({
                prompt: finalContent,
                history,
                userId,
                username,
                displayName,
                message,
                systemPrompt: proactiveSys,
            })
            if (!response) return
            if (streamed) {
                // Reply was already sent live; still run command parser so RUN_CMDs fire.
                // If the parser rewrote the response (e.g. into a ⚠️ Confirm prompt),
                // we need to overwrite the streamed message with the rewritten text so
                // the user sees the actual confirmation, not the raw LLM output.
                let execResult = await this._executeParsedCommands(response, message)
                const finalText = execResult.text || response
                if (finalText !== response) {
                    // Stream placeholder was the last bot message we sent — fetch and edit it
                    try {
                        const recent = await message.channel.messages.fetch({ limit: 5 })
                        const ours = recent.find(
                            (m) =>
                                m.author.id === this.client.user.id && m.reference?.messageId === message.id,
                        )
                        if (ours)
                            await ours
                                .edit({ content: this.finalSecurityCheck(finalText).slice(0, 2000) })
                                .catch(() => {})
                    } catch {}
                }
                const mem = this.getMem(message.guild)
                if (!finalText.startsWith('⚠️ Confirm'))
                    mem.addConversation(userId, message.channel.id, finalContent, finalText)
                return
            }

            let execResult = await this._executeParsedCommands(response, message)
            response = execResult.text
            const extraEmbeds = execResult.embeds || []

            if (!response && !extraEmbeds.length) return

            // Never store confirmation prompts — they poison future context
            if (!response.startsWith('⚠️ Confirm')) {
                mem.addConversation(
                    userId,
                    message.channel.id,
                    finalContent,
                    response || '*(silently executed system tool)*',
                )
            }
            let hist = this.messageHistory.get(key)
            if (!hist) {
                hist = []
                this.messageHistory.set(key, hist)
            }
            hist.push({ role: 'user', content: finalContent })
            if (!response.startsWith('⚠️ Confirm')) {
                hist.push({ role: 'assistant', content: response || '*(silently executed system tool)*' })
            }
            const media = await this._pickExpressiveMedia(response, message)
            const chunks = this.splitResponse(response || '')
            if (!chunks.length || (chunks.length === 1 && !chunks[0])) {
                if (extraEmbeds.length)
                    await this.secureReply(message, '', { embeds: extraEmbeds.slice(0, 10) })
            } else {
                for (let i = 0; i < Math.min(chunks.length, 4); i++) {
                    const isLast = i === Math.min(chunks.length, 4) - 1 || i === chunks.length - 1
                    await this.secureReply(message, chunks[i], {
                        allowedMentions: { parse: this.replyPing ? ['users'] : [] },
                        embeds: isLast ? extraEmbeds.slice(0, 10) : [],
                    })
                }
            }
            if (media) {
                try {
                    if (media.sticker) {
                        await message.channel.send({ stickers: [media.sticker] })
                    } else if (media.gif) {
                        await message.channel.send({ content: media.gif })
                    }
                } catch {}
            }
        } finally {
            if (typingInterval) clearInterval(typingInterval)
        }
    }

    async processAIMessage(message) {
        if (this.paused || this.shouldIgnore(message)) return
        if (!this.isTrigger(message)) return
        const guildId = message.guild?.id ?? '0'
        if (guildId !== '0' && !this.aiAllowedGuilds.has(guildId)) return

        const userId = message.author.id
        const isStaff = !!message.member?.permissions?.has(PermissionFlagsBits.ModerateMembers)
        const isOwner = String(userId) === String(OWNER_ID)
        const gate = this.client.heart?.rateLimiter?.check(userId, { isStaff, isOwner })
        if (gate && !gate.ok) return
        const now = Date.now()

        // Block new AI responses while a destructive confirmation is pending for this user
        if ([...this._pendingConfirms.keys()].some((k) => k.startsWith(`${userId}:`))) return

        // Spam protection
        let counts = this.userMsgCounts.get(userId) ?? []
        counts = counts.filter((t) => now - t < this.spamWindow)
        counts.push(now)
        this.userMsgCounts.set(userId, counts)
        if (this.userCooldowns.has(userId) && now < this.userCooldowns.get(userId)) return
        if (counts.length > this.spamThreshold) {
            this.userCooldowns.set(userId, now + this.cooldownDuration)
            this.userMsgCounts.set(userId, [])
            return
        }

        try {
            await this.handleAIResponse(message)
        } catch (e) {
            console.error('[AI] handleAIResponse error:', e)
        }
    }

    async onMessage(message) {
        if (message.author.bot || message.author.id === this.client.user.id) return
        if (this.paused) return
        if (!this.allowDM && message.channel.type === 1) return
        if (message.guild && this.allowedGuilds.size && !this.allowedGuilds.has(message.guild.id)) return
        if (this.shouldIgnore(message)) return
        if (this.triggeredMsgs.has(message.id)) return
        // Allow messages with no text if they carry images/attachments — vision pipeline needs them
        const hasMedia =
            message.attachments?.size > 0 ||
            message.embeds?.some((e) => e.image?.url || e.thumbnail?.url || e.data?.type === 'gifv')
        if (!message.content && !hasMedia) return
        if (message.guild) {
            const ownerScope = `${message.guild.id}:${OWNER_ID}`
            if (this.ghost.isGhosted(ownerScope, message.author.id)) return
        }
        const now = Date.now()
        let ts = this.spamProtect.get(message.author.id) ?? []
        ts = ts.filter((t) => now - t < 5000)
        if (ts.length >= 5) return
        ts.push(now)
        this.spamProtect.set(message.author.id, ts)

        const raw = message.content.trim()
        const lower = raw.toLowerCase()
        const mention = `<@${this.client.user.id}>`
        const mentionAlt = `<@!${this.client.user.id}>`

        // Confirmation replies (non-reply-to-bot path — bare "yes"/"no" in channel)
        const userHasPending = [...this._pendingConfirms.keys()].some((k) =>
            k.startsWith(`${message.author.id}:`),
        )
        if (userHasPending && (lower === 'yes' || lower === 'no')) {
            const now = Date.now()
            for (const [key, val] of this._pendingConfirms) {
                if (now - val.ts > 30_000) {
                    this._pendingConfirms.delete(key)
                    continue
                }
                if (!key.startsWith(`${message.author.id}:`)) continue
                this._pendingConfirms.delete(key)
                if (lower === 'no') {
                    await message.react('❌').catch(() => {})
                    return
                }
                const [, cmdName] = key.split(':')
                // Full args are stored in the value, not the key (key is sanitized for lookup)
                const args = (val.args ?? '').split(/\s+/).filter(Boolean)
                const handler = this.client.commands?.get(cmdName)
                if (handler) {
                    try {
                        await handler(message, args)
                        await message.react('✅').catch(() => {})
                        console.log(
                            `[AI] Confirmed and executed '${cmdName}' args='${val.args}' by ${message.author.id}`,
                        )
                    } catch (e) {
                        console.error('[AI] Confirmed exec error:', e)
                    }
                }
                return
            }
            // User had a pending confirm but it expired — absorb yes/no, don't send to AI
            return
        }

        // Prefix commands take precedence — "med, snaek" is a prefix attempt, not an AI trigger.
        if (lower.startsWith(PREFIX)) return

        const replyResolved = await this._resolveReplyContext(message)
        const repliedTo = replyResolved?.ref?.author ?? null
        const isReplyToBot = repliedTo?.id === this.client.user.id

        // If replying to a bot message with yes/no, always treat as a confirmation attempt.
        // If no active confirm found, absorb silently — never send to AI.
        if (isReplyToBot && (lower === 'yes' || lower === 'no')) {
            const now = Date.now()
            for (const [key, val] of this._pendingConfirms) {
                if (now - val.ts > 30_000) {
                    this._pendingConfirms.delete(key)
                    continue
                }
                if (!key.startsWith(`${message.author.id}:`)) continue
                this._pendingConfirms.delete(key)
                if (lower === 'no') {
                    await message.react('❌').catch(() => {})
                    return
                }
                const [, cmdName] = key.split(':')
                const args = (val.args ?? '').split(/\s+/).filter(Boolean)
                const handler = this.client.commands?.get(cmdName)
                if (handler) {
                    try {
                        await handler(message, args)
                        await message.react('✅').catch(() => {})
                        console.log(
                            `[AI] Confirmed and executed '${cmdName}' args='${val.args}' by ${message.author.id}`,
                        )
                    } catch (e) {
                        console.error('[AI] Confirmed exec error:', e)
                    }
                }
                return
            }
            return // Reply-to-bot yes/no with no active confirm — absorb, don't send to AI
        }
        let replyCtx = null
        if (replyResolved) {
            const { label, textContext, hasText } = replyResolved
            // Prefix makes it unambiguous to the model that this is metadata, not user content.
            // Also: truncate aggressively so we don't poison the reply when the original was long.
            const NL = String.fromCharCode(10)
            const ctxBody = hasText ? textContext.slice(0, 300).split(NL).join(' ') : '(empty)'
            replyCtx =
                `[INTERNAL CONTEXT — do NOT quote, do NOT repeat, do NOT format as a user message.` +
                ` The user is replying to ${label}: "${ctxBody}"]`
        }

        const isReplyToMe = repliedTo?.id === this.client.user.id

        const _botMentionRx = new RegExp(`^<@!?${this.client.user.id}>\\s+`)
        // A typed @ping at the start counts as a summon even if the message is also a reply to her.
        // (Discord doesn't put the reply auto-ping into raw content, so a bare reply still won't match.)
        const startsWithExplicitPing = _botMentionRx.test(raw)
        const hasTrig = this._triggerRegexes.some((rx) => rx.test(lower))
        const isMention = startsWithExplicitPing
        const isAlways = this.alwaysActiveCh.has(message.channel.id)

        let trigger = false
        let prompt = raw

        if (isAlways && (isMention || isReplyToMe || hasTrig)) {
            trigger = true
            if (replyCtx)
                prompt = `${replyCtx}

${raw}`
        } else if (isReplyToMe && hasMedia) {
            // Regular channel reply-to-bot with image attached — treat as explicit "look at this"
            trigger = true
            prompt = replyCtx
                ? `${replyCtx}

${raw || 'what do you see'}`
                : raw || 'what do you see'
        } else if (startsWithExplicitPing) {
            // Regular channel: ONLY an explicit @Medusa at the start (not a reply-auto-ping)
            const cleaned = raw.replace(_botMentionRx, '').trim()
            if (cleaned) {
                trigger = true
                prompt = replyCtx
                    ? `${replyCtx}

${cleaned}`
                    : cleaned
            }
        }

        if (trigger) {
            const guildId = message.guild?.id ?? '0'
            if (guildId !== '0' && !this.aiAllowedGuilds.has(guildId)) return

            if ([...this._pendingConfirms.keys()].some((k) => k.startsWith(`${message.author.id}:`))) return

            this.triggeredMsgs.add(message.id)
            this.processedMsgIds.add(message.id)

            try {
                const userId = message.author.id
                const ctx = await this.getUserContext(userId, message)
                const userSys =
                    this.getUserPrompt(userId) ||
                    'You are Medusa, a helpful AI with a warm, caring personality on Discord. Respond in first person.'
                const fullSys = `${userSys}\n\n${ctx}`

                await this.handleAIResponse(message, prompt, fullSys)
            } catch (e) {
                console.error('[AI] trigger handler error:', e)
            }
        } else {
            await this.processAIMessage(message)
        }
    }

    // Resolve :emojiName: shortcodes → full <:name:ID> Discord format
    // LLMs habitually write :name: even when given the full format — handle it here instead of trusting the prompt
    _resolveCustomEmojis(text, guild) {
        if (!guild?.emojis?.cache?.size || !text) return text
        return text.replace(/:([a-zA-Z0-9_]{2,32}):/g, (match, name) => {
            const emoji = guild.emojis.cache.find((e) => e.name === name)
            if (!emoji) return match
            return `<${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}>`
        })
    }

    // Expressive media — stickers, server emojis, GIFs
    // Called after response is finalized. Returns { sticker, gif } or null.
    // Never fires on serious/mod/research-heavy responses.
    async _pickExpressiveMedia(response, message) {
        if (!message?.guild) return null
        const text = response.toLowerCase()
        // Hard blocks — never attach media on these
        const SERIOUS = /\b(ban|mute|warn|kick|purge|moderat|you are (now|hereby)|action has been|case #)\b/i
        const NSFW_BLOCK = /\b(nsfw|porn|nude|sex|hentai|lewd|explicit)\b/i
        if (SERIOUS.test(response) || NSFW_BLOCK.test(response)) return null
        // Skip if response is just a command execution (no real text)
        if (response.trim().startsWith('⚙️') || response.length < 20) return null
        // Tone detection
        const isFunny = /\b(lmao|lol|💀|😭|😂|💀|bruh|bro|omg|dead|crying|aint no way|no cap|bffr)\b/.test(
            text,
        )
        const isHype = /\b(lets go|yesss|slay|bestie|periodt|love|excited|amazing|fire|🔥|💜|✨)\b/.test(text)
        const isConfused = /\b(wait what|huh|idk|honestly|lowkey|hmm|i mean)\b/.test(text)
        const isChaos = /\b(skull|💀|😭|unhinged|chaotic|wild|insane|absolutely not)\b/.test(text)
        const isPositive = isHype || isFunny
        const anythingTriggered = isFunny || isHype || isConfused || isChaos

        if (!anythingTriggered) return null
        // 40% chance even when triggered — keeps it rare and earned
        if (Math.random() > 0.4) return null

        const result = {}

        // Sticker pick
        const stickers = [...message.guild.stickers.cache.values()]
        if (stickers.length) {
            const safe = stickers.filter((s) => {
                const n = (s.name + (s.description ?? '')).toLowerCase()
                return !/nsfw|nude|sex|porn|lewd/.test(n)
            })
            if (safe.length && Math.random() > 0.5) {
                // Pick contextually: prefer stickers whose name matches tone keywords
                const toneWords = [
                    ...(isFunny
                        ? [
                              'lol',
                              'cry',
                              'dead',
                              'skull',
                              'bruh',
                              'lmao',
                              'sob',
                              'bradar',
                              'i drink soda i eat pizza',
                              '',
                          ]
                        : []),
                    ...(isHype
                        ? ['hype', 'love', 'yes', 'fire', 'slay', 'hug', 'heart', 'citrus anime']
                        : []),
                    ...(isConfused ? ['huh', 'what', 'think', 'confused', 'hmm', 'mgs think'] : []),
                    ...(isChaos ? ['skull', 'dead', 'chaos', 'cry', 'evil', 'mambo', 'carti'] : []),
                ]
                const matched = safe.filter((s) => toneWords.some((w) => s.name.toLowerCase().includes(w)))
                result.sticker = matched.length
                    ? matched[Math.floor(Math.random() * matched.length)]
                    : safe[Math.floor(Math.random() * safe.length)]
            }
        }

        // GIF fetch logic (Giphy + Free Fallback)
        if (!result.sticker && Math.random() > 0.6) {
            const giphyKey = this._config?.giphyKey ?? this._config?.giphy_api_key
            let fetchedGif = null

            // 1. Try Giphy if API key exists
            if (giphyKey) {
                const queries = [
                    ...(isFunny ? ['anime crying laughing', 'bruh moment', 'anime skull'] : []),
                    ...(isHype ? ['anime hype', 'lets go anime', 'anime slay'] : []),
                    ...(isConfused ? ['anime confused', 'anime wait what', 'anime thinking'] : []),
                    ...(isChaos ? ['anime unhinged', 'anime chaos', 'anime stare'] : []),
                ]
                if (queries.length) {
                    const q = queries[Math.floor(Math.random() * queries.length)]
                    try {
                        const res = await fetch(
                            `https://api.giphy.com/v1/gifs/search?api_key=${giphyKey}&q=${encodeURIComponent(q)}&limit=10&rating=pg-13&lang=en`,
                            { signal: AbortSignal.timeout(3000) },
                        )
                        const data = await res.json()
                        const results = data?.data ?? []
                        if (results.length)
                            fetchedGif =
                                results[Math.floor(Math.random() * results.length)]?.images?.original?.url
                    } catch {}
                }
            }

            // 2. Fallback to free SFW anime API (nekos.best) if Giphy isn't set or failed
            if (!fetchedGif) {
                const categories = [
                    ...(isFunny ? ['laugh', 'smile', 'smug'] : []),
                    ...(isHype ? ['dance', 'happy', 'highfive', 'wave'] : []),
                    ...(isConfused ? ['stare', 'shrug', 'facepalm'] : []),
                    ...(isChaos ? ['yeet', 'slap', 'kick', 'punch', 'bite'] : []),
                ]
                if (categories.length) {
                    const cat = categories[Math.floor(Math.random() * categories.length)]
                    try {
                        const res = await fetch(`https://nekos.best/api/v2/${cat}?amount=1`, {
                            signal: AbortSignal.timeout(3000),
                        })
                        const data = await res.json()
                        if (data?.results?.[0]?.url) fetchedGif = data.results[0].url
                    } catch {}
                }
            }

            if (fetchedGif) result.gif = fetchedGif
        }

        return Object.keys(result).length ? result : null
    }

    // Random messages
    async sendRandomMessage() {
        if (!this.funChannels.size) return
        this.lastRandomMsg = Date.now()
        try {
            const chId = [...this.funChannels][Math.floor(Math.random() * this.funChannels.size)]
            const ch = this.client.channels.cache.get(chId)
            if (!ch) return
            const types = ['roast', 'dark_humor', 'fun_fact', 'observation', 'philosophical']
            const weights = [10, 1, 1, 1, 1]
            let type,
                roll = Math.random() * weights.reduce((a, b) => a + b, 0)
            for (let i = 0; i < weights.length; i++) {
                roll -= weights[i]
                if (roll <= 0) {
                    type = types[i]
                    break
                }
            }

            let content = null
            if (type === 'roast') content = await this._generateRoast(ch.guild)
            else {
                const prompts = {
                    dark_humor:
                        'Generate a short, witty dark humor joke or observation. Keep it clever and not offensive. 1-2 sentences max.',
                    fun_fact:
                        'Share an interesting, weird, or surprising fun fact. Make it engaging and add a witty comment.',
                    observation:
                        'Make a random, amusing observation about life, technology, or human behavior. Be witty and relatable.',
                    philosophical:
                        'Ask a thought-provoking or absurd philosophical question. Add a brief witty comment.',
                }
                content = await this.generateResponse({
                    prompt: prompts[type],
                    systemPrompt:
                        'You are Medusa with dark humor and wit. Be clever, funny, engaging. Keep responses short and punchy. Use emojis sparingly.',
                })
            }
            if (content) await ch.send({ content: this.finalSecurityCheck(content) })
        } catch (e) {
            console.error('[AI] sendRandomMessage error:', e)
        }
    }

    async _generateRoast(guild) {
        if (!guild) return null
        const mem = this.getMem(guild)
        try {
            if (!mem.db) return null
            const row = mem.db
                .prepare(
                    `
                SELECT user_id, message_content FROM conversations
                WHERE LENGTH(message_content) > 20
                AND message_content NOT LIKE '%?%'
                AND message_content NOT LIKE '%how%'
                AND message_content NOT LIKE '%what%'
                AND message_content NOT LIKE '%when%'
                AND message_content NOT LIKE '%where%'
                AND message_content NOT LIKE '%http%'
                AND message_content NOT LIKE '%discord.gg%'
                AND message_content NOT LIKE '%discord.com/invite%'
                AND message_content NOT LIKE '%tenor.com%'
                AND message_content NOT LIKE '%cdn.discord%'
                AND message_content NOT LIKE '%bit.ly%'
                AND message_content NOT LIKE '%.com/%'
                AND message_content NOT LIKE '%.gg/%'
                ORDER BY RANDOM() LIMIT 1
            `,
                )
                .get()
            if (!row) return null

            const userInfo = mem.getUser(row.user_id)
            const displayName = userInfo?.display_name || userInfo?.username || `User${row.user_id}`
            const quote = row.message_content

            const roast = await this.generateResponse({
                prompt: `Generate a witty, sarcastic roast or commentary about this quote. Be playful and humorous, not actually mean. Keep it under 60 words.\nQuote: "${quote.slice(0, 200)}"\nSaid by: ${displayName}\nMake it funny and creative. Point out irony, make a clever observation, add dark humor, be sarcastic but not cruel. Reference the quote directly.`,
                systemPrompt:
                    'You are Medusa with a sharp wit. Generate clever, funny roasts and commentary. Be sarcastic and humorous but not genuinely mean or hurtful.',
            })
            if (!roast) return null
            // Strip any URLs the LLM hallucinated from the quote context — prevents invite/link injection
            const safeRoast = roast
                .replace(/https?:\/\/\S+/gi, '')
                .replace(/discord\.gg\/\S+/gi, '')
                .replace(/\s{2,}/g, ' ')
                .trim()
            const safeQuote = quote.replace(/https?:\/\/\S+/gi, '[link]').slice(0, 150)
            if (!safeRoast) return null
            return `**${displayName}**: "${safeQuote}${quote.length > 150 ? '...' : ''}"\n\n${safeRoast}`
        } catch (e) {
            console.error('[AI] generateRoast error:', e)
        }
        return null
    }

    // Cleanup
    _periodicCleanup() {
        const now = Date.now()
        // Prune expired conversation windows
        for (const [key, ts] of this.activeConvs) {
            if (now - ts > this.convTimeout * 2) this.activeConvs.delete(key)
        }
        // Trim message history: keep top 50 active convos.
        if (this.messageHistory.size > 100) {
            const sorted = [...this.messageHistory.entries()].sort(
                (a, b) => (this.activeConvs.get(b[0]) ?? 0) - (this.activeConvs.get(a[0]) ?? 0),
            )
            const toKeep = new Set(sorted.slice(0, 50).map(([k]) => k))
            for (const [k, v] of sorted) {
                if (!toKeep.has(k)) {
                    this.messageHistory.delete(k)
                } else if (v.length > this.maxHistory) {
                    this.messageHistory.set(k, v.slice(-this.maxHistory))
                }
            }
        }
        this.repliedMsgCache.clear()
        if (this.responseTimes.length > 100) this.responseTimes = this.responseTimes.slice(-50)
        for (const [k, q] of this.msgQueues) if (!q.length) this.msgQueues.delete(k)
        // Prune spamProtect
        for (const [uid, ts] of this.spamProtect) {
            const fresh = ts.filter((t) => now - t < 30_000)
            if (!fresh.length) this.spamProtect.delete(uid)
            else this.spamProtect.set(uid, fresh)
        }
        // Cleanup old DB entries
        for (const mem of [this.globalMem, ...this.isolatedMems.values()]) {
            try {
                mem.cleanupOld(PERF.maintenance.retentionDays)
            } catch {}
        }
    }
}

// Register function (called from index.js)
let OWNER_ID = null
const ownerOnly = (fn) => async (msg, args) => {
    if (String(msg.author.id) !== String(OWNER_ID)) return
    await fn(msg, args)
}
export async function registerAI(client, db, config) {
    OWNER_ID = config.owner_id
    try {
        const mod = await import('better-sqlite3')
        globalThis._sqlite3 = { default: mod.default ?? mod }
    } catch (e) {
        console.error('[AI] better-sqlite3 not available — install on host:', e.message)
    }
    try {
        const dataDir = 'Ai Database'
        const sentinel = join(dataDir, '.migrated-v1')
        if (existsSync(dataDir) && !existsSync(sentinel)) {
            const folderPattern = /^(.+) - (\d{17,20})$/
            // Group folders by guild ID
            const byGuild = new Map()
            for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
                if (!entry.isDirectory()) continue
                const match = entry.name.match(folderPattern)
                if (!match) {
                    // Check for bare-ID folders from previous revision
                    if (/^\d{17,20}$/.test(entry.name)) {
                        const arr = byGuild.get(entry.name) || []
                        arr.push({
                            path: join(dataDir, entry.name),
                            name: entry.name,
                            guildId: entry.name,
                            isBareId: true,
                        })
                        byGuild.set(entry.name, arr)
                    }
                    continue
                }
                const [, , guildId] = match
                const arr = byGuild.get(guildId) || []
                arr.push({ path: join(dataDir, entry.name), name: entry.name, guildId })
                byGuild.set(guildId, arr)
            }

            for (const [guildId, folders] of byGuild) {
                if (folders.length <= 1 && !folders[0]?.isBareId) continue
                // Sort by DB size descending — keep the largest as the primary
                folders.sort((a, b) => {
                    const aDb = join(a.path, 'memory.db')
                    const bDb = join(b.path, 'memory.db')
                    const aSize = existsSync(aDb) ? statSync(aDb).size : 0
                    const bSize = existsSync(bDb) ? statSync(bDb).size : 0
                    return bSize - aSize
                })
                const primary = folders[0]
                const others = folders.slice(1)

                if (!others.length) continue // only bare-ID folder, will be renamed by _resolveAndSync at runtime

                const primaryDb = join(primary.path, 'memory.db')
                if (!existsSync(primaryDb)) continue

                for (const other of others) {
                    const otherDb = join(other.path, 'memory.db')
                    if (!existsSync(otherDb)) continue
                    try {
                        const { default: Database } = globalThis._sqlite3
                        const dst = new Database(primaryDb)
                        dst.exec(`ATTACH DATABASE '${otherDb.replace(/'/g, "''")}' AS src`)
                        dst.exec(`
                            INSERT OR IGNORE INTO conversations (user_id, channel_id, message_content, ai_response, timestamp)
                                SELECT user_id, channel_id, message_content, ai_response, timestamp FROM src.conversations;
                            INSERT OR IGNORE INTO users (user_id, username, display_name, conversation_count, last_interaction, created_at, updated_at)
                                SELECT user_id, username, display_name, conversation_count, last_interaction, created_at, updated_at FROM src.users
                                WHERE user_id NOT IN (SELECT user_id FROM users);
                            INSERT OR IGNORE INTO interests (user_id, topic, frequency, last_mentioned)
                                SELECT user_id, topic, frequency, last_mentioned FROM src.interests;
                            INSERT OR IGNORE INTO personality (user_id, traits, preferences, communication_style, updated_at)
                                SELECT user_id, traits, preferences, communication_style, updated_at FROM src.personality
                                WHERE user_id NOT IN (SELECT user_id FROM personality);
                        `)
                        dst.exec('DETACH DATABASE src')
                        dst.close()
                        console.log(`[AI] Merged "${other.name}" → "${primary.name}"`)
                        const { rmSync } = await import('fs')
                        rmSync(other.path, { recursive: true, force: true })
                    } catch (e) {
                        console.warn(`[AI] Could not merge "${other.name}":`, e.message)
                    }
                }
            }
        }
    } catch (e) {
        console.warn('[AI] Folder migration scan failed:', e.message)
    }

    const _passiveBuf = new Map()
    const _PASSIVE_MAX = PERF.ai.passiveBufferMax
    const _PASSIVE_CHANNELS_MAX = PERF.ai.passiveBufferChannelsMax
    globalThis._aiPassiveBuf = _passiveBuf

    const ai = new AIChatManager(client, db, config)
    client.aiCog = ai
    ai._passiveBuf = _passiveBuf // wire buffer so getUserContext() can inject live channel activity

    client.on('messageCreate', async (msg) => {
        try {
            await ai.onMessage(msg)
        } catch (e) {
            console.error('[AI] Fatal onMessage error:', e)
        }
    })

    client.on('guildMemberAdd', (member) => {
        if (!member.guild) return
        const mem = ai.getMem(member.guild)
        mem.updateUser(member.id, member.user.username, member.displayName)
    })

    client.on('messageDelete', (msg) => {
        ai.processedMsgIds?.delete?.(msg.id)
        ai.triggeredMsgs?.delete?.(msg.id)
    })

    client.on('messageCreate', (msg) => {
        if (msg.author.bot) return
        if (!msg.guild) return
        if (!msg.content?.trim()) return
        if (msg.content.length < 3) return
        const everyonePerms = msg.channel.permissionsFor(msg.guild.roles.everyone)
        if (!everyonePerms?.has('ViewChannel')) return

        if (ai.allowedGuilds.size && !ai.allowedGuilds.has(msg.guild.id)) return

        const entry = {
            userId: msg.author.id,
            displayName: msg.member?.displayName ?? msg.author.username,
            content: msg.content.slice(0, 200),
            ts: Date.now(),
        }
        let buf = _passiveBuf.get(msg.channel.id)
        if (!buf) {
            if (_passiveBuf.size >= _PASSIVE_CHANNELS_MAX) {
                const firstKey = _passiveBuf.keys().next().value
                if (firstKey) _passiveBuf.delete(firstKey)
            }
            buf = []
            _passiveBuf.set(msg.channel.id, buf)
        }
        buf.push(entry)
        if (buf.length > _PASSIVE_MAX) buf.shift()
    })

    // Auto-extract server lore every 30 min, throttled to once per 2h per guild
    const _loreExtractedAt = new Map()
    setInterval(() => {
        const now = Date.now()
        const staleTime = now - 3600_000 // 1h stale
        const minGap = 2 * 3600_000 // 2h per-guild throttle
        for (const [channelId, buf] of _passiveBuf) {
            if (!buf.length || buf[buf.length - 1].ts < staleTime) {
                _passiveBuf.delete(channelId)
                continue
            }
            if (buf.length < 5) continue
            const ch = client.channels.cache.get(channelId)
            if (!ch?.guild) continue
            const last = _loreExtractedAt.get(ch.guild.id) ?? 0
            if (now - last < minGap) continue
            _loreExtractedAt.set(ch.guild.id, now)
            try {
                ai.getMem(ch.guild).autoExtractLore(buf)
            } catch {}
        }
    }, 30 * 60_000).unref()
    // interaction listeners (AI-owned slash commands)
    client.on('interactionCreate', async (interaction) => {
        if (!interaction.isChatInputCommand()) return
        const { commandName } = interaction
        const uid = interaction.user.id
        const isOwner = uid === OWNER_ID

        // /medusa (Quick Agent) — stateless, user-installable, DM-allowed
        if (commandName === 'medusa') {
            const prompt = interaction.options.getString('prompt')
            const forceSearch = interaction.options.getBoolean('search') ?? false
            const isPrivate = interaction.options.getBoolean('private') ?? false
            const flags = isPrivate ? MessageFlags.Ephemeral : undefined

            await interaction.deferReply(flags ? { flags } : {})

            const isStaff = !!interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)
            const gate = client.heart?.rateLimiter?.check(uid, { isStaff, isOwner })
            if (gate && !gate.ok) {
                return interaction.editReply({
                    content: '⏳ Too many requests. Wait a few seconds and try again.',
                })
            }

            try {
                const response = await ai.generateStatelessResponse({ prompt, forceSearch })
                if (!response)
                    return interaction.editReply({ content: '✗ All providers failed. Try again shortly.' })

                const safe = ai.finalSecurityCheck(response)
                const chunks = ai.splitResponse(safe, 1900)
                await interaction.editReply({ content: chunks[0] || '...' })
                for (let i = 1; i < Math.min(chunks.length, 4); i++) {
                    await interaction.followUp({ content: chunks[i], ...(flags ? { flags } : {}) })
                }
            } catch (e) {
                console.error('[AI] /medusa error:', e)
                try {
                    await interaction.editReply({ content: '✗ Failed to generate response.' })
                } catch {}
            }
            return
        }

        // /summarize

        if (commandName === 'summarize') {
            const BETWEEN = 15 * 60_000,
                WINDOW = 12 * 3_600_000,
                MAX = 3
            const now = Date.now()
            if (!isOwner) {
                const uses = (ai.summarizeCDs.get(uid) ?? []).filter((t) => now - t < WINDOW)
                ai.summarizeCDs.set(uid, uses)
                if (uses.length) {
                    const sincelast = now - uses[uses.length - 1]
                    if (sincelast < BETWEEN) {
                        const rem = BETWEEN - sincelast
                        const m = Math.floor(rem / 60000),
                            s = Math.floor((rem % 60000) / 1000)
                        return interaction.reply({
                            content: `⏳ Cooldown — wait **${m}m ${s}s** before summarizing again.`,
                            flags: MessageFlags.Ephemeral,
                        })
                    }
                }
                if (uses.length >= MAX) {
                    const resets = WINDOW - (now - uses[0])
                    return interaction.reply({
                        content: `📋 You've used \`/summarize\` **${MAX}x** in the last 12h. Resets in **${Math.floor(resets / 3600000)}h ${Math.floor((resets % 3600000) / 60000)}m**.`,
                        flags: MessageFlags.Ephemeral,
                    })
                }
            }

            await interaction.deferReply()
            const startFrom = interaction.options.getString('start_from')
            let startMsg = null
            if (startFrom) {
                try {
                    startMsg = await interaction.channel.messages.fetch(startFrom)
                } catch {
                    return interaction.editReply({ content: '❌ Invalid message ID or message not found.' })
                }
            }

            const messages = []
            if (startMsg) {
                // Must use [...values()] and sort oldest-first (fetch with `after` returns newest-first).
                const fetched = await interaction.channel.messages.fetch({ limit: 100, after: startMsg.id })
                const sorted = [...fetched.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp)
                for (const m of sorted) {
                    if (!m.author.bot && m.content.trim()) {
                        messages.push({
                            author: m.member?.displayName ?? m.author.username,
                            content: m.content,
                            ts: m.createdAt,
                        })
                        if (messages.length >= 100) break
                    }
                }
                if (!startMsg.author.bot && startMsg.content.trim())
                    messages.unshift({
                        author: startMsg.member?.displayName ?? startMsg.author.username,
                        content: startMsg.content,
                        ts: startMsg.createdAt,
                    })
            } else {
                const fetched = await interaction.channel.messages.fetch({ limit: 200 })
                for (const [, m] of fetched) {
                    if (!m.author.bot && m.content.trim()) {
                        messages.push({
                            author: m.member?.displayName ?? m.author.username,
                            content: m.content,
                            ts: m.createdAt,
                        })
                        if (messages.length >= 100) break
                    }
                }
                messages.reverse()
            }
            if (!messages.length)
                return interaction.editReply({ content: '❌ No messages found to summarize.' })

            const participants = [...new Set(messages.map((m) => m.author))]
            const convText = messages
                .slice(-75)
                .map((m) => `**${m.author}**: ${m.content}`)
                .join('\n')
            const summaryPrompt = `Analyze this conversation and provide a clear, well-structured summary.\n**Participants:** '${participants.join("', '")}'\n**Formatting:** **bold** for key points, bullet points for key events.\n**Include:** main topics, key participants, decisions/outcomes, conflicts/resolutions, flow of discussion.\nEnd with "> **📋 TL;DR:**" (2-3 lines).\nConversation (${messages.length} messages):\n${convText}`
            const summary = await ai.generateResponse({
                prompt: summaryPrompt,
                systemPrompt:
                    'You are Medusa, an expert conversation analyst. Provide concise, clear summaries. Use minimal blank lines, structured bullets, and avoid fluff.',
            })
            if (!summary)
                return interaction.editReply({ content: '❌ Failed to generate summary. Please try again.' })

            const first = messages[0].ts,
                last = messages[messages.length - 1].ts
            const header = `> 📋 **Conversation Summary**${startMsg ? ` (from message \`${startMsg.id}\`)` : ` (last ${messages.length} messages)`}\n> \`🕒| ${first.toISOString().slice(0, 16)}\` **__→__** \`${last.toISOString().slice(0, 16)} UTC\`\n> 👥| **${participants.length} users**\n${'─'.repeat(40)}`
            const full = `${header}\n${summary}`.slice(0, 2000)
            await interaction.editReply({ content: full })

            if (!isOwner) {
                const uses = ai.summarizeCDs.get(uid) ?? []
                uses.push(now)
                ai.summarizeCDs.set(uid, uses)
            }
            return
        }

        // /memory
        if (commandName === 'memory') {
            const userId = interaction.user.id
            const mem = ai.getMem(interaction.guild)
            const user = mem.getUser(userId)
            const ints = mem.getInterests(userId, 8)
            const pers = mem.getPersonality(userId)
            const embed = new EmbedBuilder()
                .setTitle(`🧠 Medusa's Memory — ${interaction.user.displayName}`)
                .setColor(0x7f77dd)
            if (user) {
                const level =
                    user.conversation_count > 50
                        ? '🔥 active'
                        : user.conversation_count > 10
                          ? '👋 regular'
                          : '🌱 new'
                embed.addFields({
                    name: '📊 Profile',
                    value: `Conversations: \`${user.conversation_count}\` (${level})\nLast seen: \`${String(user.last_interaction ?? 'never').slice(0, 10)}\``,
                    inline: false,
                })
            } else {
                embed.addFields({
                    name: '📊 Profile',
                    value: 'No profile stored yet — say hi!',
                    inline: false,
                })
            }
            if (ints.length)
                embed.addFields({
                    name: '🎯 Top Interests',
                    value:
                        ints
                            .slice(0, 6)
                            .map((r) => `\`${r.topic}\``)
                            .join(', ') || 'None yet',
                    inline: false,
                })
            if (pers?.traits)
                embed.addFields({ name: '🎭 Detected Personality', value: pers.traits, inline: false })
            embed.setFooter({
                text: 'Use /forgetme to wipe this data. • Medusa',
                iconURL: interaction.user.displayAvatarURL(),
            })
            return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral })
        }

        // /forgetme
        if (commandName === 'forgetme') {
            const userId = interaction.user.id
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('fm_confirm')
                    .setLabel('Confirm wipe')
                    .setStyle(ButtonStyle.Danger)
                    .setEmoji('✅'),
                new ButtonBuilder()
                    .setCustomId('fm_cancel')
                    .setLabel('Cancel')
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('❌'),
            )
            const embed = new EmbedBuilder()
                .setTitle('⚠️ Are you sure?')
                .setDescription(
                    'This will **permanently delete** everything Medusa remembers about you:\n• Conversation history\n• Interests & topics\n• Personality profile\n• Aliases',
                )
                .setColor(0xef9f27)
            const response = await interaction.reply({
                embeds: [embed],
                components: [row],
                flags: MessageFlags.Ephemeral,
                withResponse: true,
            })
            const msg = response.resource?.message || (await interaction.fetchReply())
            const col = msg.createMessageComponentCollector({
                componentType: ComponentType.Button,
                time: 30_000,
            })
            col.on('collect', async (i) => {
                if (i.user.id !== userId)
                    return i.reply({ content: 'Not your button.', flags: MessageFlags.Ephemeral })
                col.stop()
                if (i.customId === 'fm_cancel')
                    return i.update({
                        content: 'Cancelled — your memory is safe 💜',
                        embeds: [],
                        components: [],
                    })
                const managers = [ai.globalMem, ...ai.isolatedMems.values()]
                for (const m of managers)
                    try {
                        m.wipeUser(userId)
                    } catch {}
                ai._invalidateUserCache(userId)
                for (const k of [...ai.messageHistory.keys()])
                    if (k.startsWith(`${userId}-`)) ai.messageHistory.delete(k)
                if (ai.customPrompts[userId]) {
                    delete ai.customPrompts[userId]
                    if (ai._promptSaveTimer) clearTimeout(ai._promptSaveTimer)
                    ai._promptSaveTimer = setTimeout(() => {
                        ai._saveJSON('Ai Database/custom_prompts.json', ai.customPrompts)
                        ai._promptSaveTimer = null
                    }, 500)
                }
                await i.update({
                    content: '✅ Done — Medusa has forgotten everything about you. Fresh start 🌸',
                    embeds: [],
                    components: [],
                })
            })
            col.on('end', () => interaction.editReply({ components: [] }).catch(() => {}))
            return
        }

        // /mode
        if (commandName === 'mode') {
            const input = interaction.options.getString('mode')
            const uid2 = interaction.user.id
            if (!input) {
                const cur = ai.userModes[uid2] ?? 0
                return interaction.reply({
                    content: `Your current mode is: **${cur === 1 ? 'focused' : 'normal'}** (${cur}).\nUse \`/mode focused\` or \`/mode normal\` to switch.`,
                    flags: MessageFlags.Ephemeral,
                })
            }
            if (['focused', '1'].includes(input)) {
                ai.userModes[uid2] = 1
                ai._saveJSON('Ai Database/user_modes.json', ai.userModes)
                return interaction.reply({
                    content: '✅ Switched to **focused mode** - task-oriented responses',
                    flags: MessageFlags.Ephemeral,
                })
            }
            if (['normal', '0'].includes(input)) {
                ai.userModes[uid2] = 0
                ai._saveJSON('Ai Database/user_modes.json', ai.userModes)
                return interaction.reply({
                    content: '✅ Switched to **normal mode** - Full personality and casual responses',
                    flags: MessageFlags.Ephemeral,
                })
            }
            return interaction.reply({
                content: '❌ Invalid mode. Use `focused`/`1` or `normal`/`0`',
                flags: MessageFlags.Ephemeral,
            })
        }

        // lore
        if (commandName === 'lore') {
            if (!interaction.guild)
                return interaction.reply({ content: 'Server only.', flags: MessageFlags.Ephemeral })
            const mem = ai.getMem(interaction.guild)
            const sub = interaction.options.getSubcommand()
            const isMod =
                interaction.member?.permissions?.has('ManageGuild') || interaction.user.id === OWNER_ID
            if (sub === 'list') {
                const lore = mem.getLore(20)
                if (!lore.length)
                    return interaction.reply({
                        content: '📖 No server lore recorded yet.',
                        flags: MessageFlags.Ephemeral,
                    })
                const lines = lore.map((l) => `\`${l.id}\` [${l.source}×${l.frequency}] ${l.fact}`)
                return interaction.reply({
                    content: `📖 **Server Lore:**\n${lines.join('\n')}`,
                    flags: MessageFlags.Ephemeral,
                })
            }
            if (!isMod)
                return interaction.reply({
                    content: '❌ Manage Guild permission required.',
                    flags: MessageFlags.Ephemeral,
                })
            if (sub === 'add') {
                const fact = interaction.options.getString('fact')
                const ok = mem.addLore(fact, 'manual')
                return interaction.reply({
                    content: ok ? `✅ Lore added: "${fact}"` : '❌ Invalid or too long (max 120 chars).',
                    flags: MessageFlags.Ephemeral,
                })
            }
            if (sub === 'remove') {
                const id = interaction.options.getInteger('id')
                mem.removeLore(id)
                return interaction.reply({
                    content: `✅ Lore entry #${id} removed.`,
                    flags: MessageFlags.Ephemeral,
                })
            }
            if (sub === 'clear') {
                mem.db.prepare(`DELETE FROM server_lore WHERE source='auto'`).run()
                return interaction.reply({
                    content: '✅ All auto-extracted lore cleared.',
                    flags: MessageFlags.Ephemeral,
                })
            }
        }

        // ghost
        if (commandName === 'ghost') {
            const sub = interaction.options.getSubcommand()
            const scope = `${interaction.guild?.id ?? 'dm'}:${interaction.user.id}`
            if (sub === 'add') {
                const target = interaction.options.getUser('user')
                ai.ghost.add(scope, target.id)
                return interaction.reply({
                    content: `👻 Ghosted **${target.username}** — their messages won't influence your AI context.`,
                    flags: MessageFlags.Ephemeral,
                })
            }
            if (sub === 'remove') {
                const target = interaction.options.getUser('user')
                ai.ghost.remove(scope, target.id)
                return interaction.reply({
                    content: `✅ Removed **${target.username}** from ghost list.`,
                    flags: MessageFlags.Ephemeral,
                })
            }
            if (sub === 'list') {
                const list = ai.ghost.list(scope)
                if (!list.length)
                    return interaction.reply({ content: 'No ghosted users.', flags: MessageFlags.Ephemeral })
                const lines = list.map((id) => {
                    const u = client.users.cache.get(id)
                    return u ? `${u.username} (\`${id}\`)` : `\`${id}\``
                })
                return interaction.reply({
                    content: `👻 **Ghost list:**\n${lines.join('\n')}`,
                    flags: MessageFlags.Ephemeral,
                })
            }
            if (sub === 'clear') {
                ai.ghost.clear(scope)
                return interaction.reply({ content: '✅ Ghost list cleared.', flags: MessageFlags.Ephemeral })
            }
        }

        // owner-only commands
        if (!isOwner) return

        if (commandName === 'aipause') {
            ai.paused = !ai.paused
            return interaction.reply({
                content: `AI ${ai.paused ? 'paused' : 'unpaused'}`,
                flags: MessageFlags.Ephemeral,
            })
        }
        if (commandName === 'aireinit') {
            ai._initGroq()
            return interaction.reply({
                content: `Reinitialized. Success: ${!!ai._groq}`,
                flags: MessageFlags.Ephemeral,
            })
        }
        if (commandName === 'aimodel') {
            const model = interaction.options.getString('model')
            if (!model) {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral })
                try {
                    const key = ai.aiTokens[ai.currentKeyIdx]
                    const res = await fetch('https://api.groq.com/openai/v1/models', {
                        headers: { Authorization: `Bearer ${key}` },
                    })
                    const data = await res.json()
                    const models = (data.data || [])
                        .filter((m) => m.active)
                        .map((m) => `\`${m.id}\``)
                        .join(', ')
                    return interaction.editReply({
                        content: `Current: \`${ai.aiModel}\`\n\n**Available Models:**\n${models || 'Could not fetch list.'}`,
                    })
                } catch (e) {
                    return interaction.editReply({
                        content: `Current: \`${ai.aiModel}\`\nFailed to fetch models from API.`,
                    })
                }
            }
            ai.aiModel = model
            // Runtime state lives in memory never mutate source config
            try {
                const runtimePath = 'runtime.json'
                let runtime = {}
                if (existsSync(runtimePath)) {
                    runtime = JSON.parse(readFileSync(runtimePath, 'utf8'))
                }
                runtime.aiModel = model
                writeFileSync(runtimePath, JSON.stringify(runtime, null, 2))
            } catch (e) {
                console.error('[AI] Failed to persist runtime state:', e)
            }
            return interaction.reply({ content: `Model set to: \`${model}\``, flags: MessageFlags.Ephemeral })
        }
        if (commandName === 'iso') {
            const guild = interaction.guild
            if (!guild)
                return interaction.reply({
                    content: 'Must be used in a server.',
                    flags: MessageFlags.Ephemeral,
                })
            if (ai.isolatedServers.has(guild.id))
                return interaction.reply({
                    content: `**${guild.name}** is already isolated.`,
                    flags: MessageFlags.Ephemeral,
                })
            ai.isolatedServers.add(guild.id)
            ai.isolatedMems.set(guild.id, new AIMemoryManager(guild.id, guild.name))
            config.isolated_servers = [...ai.isolatedServers]
            try {
                globalThis._saveConfig?.(config)
            } catch {}
            return interaction.reply({
                content: `✅ **${guild.name}** isolated — now has its own AI memory.`,
                flags: MessageFlags.Ephemeral,
            })
        }
        if (commandName === 'uniso') {
            const guild = interaction.guild
            if (!guild)
                return interaction.reply({
                    content: 'Must be used in a server.',
                    flags: MessageFlags.Ephemeral,
                })
            if (!ai.isolatedServers.has(guild.id))
                return interaction.reply({
                    content: `**${guild.name}** is not isolated.`,
                    flags: MessageFlags.Ephemeral,
                })
            ai.isolatedServers.delete(guild.id)
            ai.isolatedMems.delete(guild.id)
            config.isolated_servers = [...ai.isolatedServers]
            try {
                globalThis._saveConfig?.(config)
            } catch {}
            return interaction.reply({
                content: `✅ **${guild.name}** un-isolated — using global memory now.`,
                flags: MessageFlags.Ephemeral,
            })
        }
        if (commandName === 'aiwipe') {
            ai.messageHistory.clear()
            for (const m of [ai.globalMem, ...ai.isolatedMems.values()]) {
                try {
                    m.db.exec(
                        'DELETE FROM conversations; DELETE FROM interests; DELETE FROM personality; DELETE FROM users; DELETE FROM relationships; DELETE FROM user_aliases;',
                    )
                } catch {}
            }
            return interaction.reply({ content: 'AI memory wiped', flags: MessageFlags.Ephemeral })
        }
        if (commandName === 'pm') {
            const mode = interaction.options.getString('mode')
            if (!mode)
                return interaction.reply({
                    content: `Ping mode: **${ai.pingMode ? 'enabled' : 'disabled'}**`,
                    flags: MessageFlags.Ephemeral,
                })
            ai.pingMode = ['on', 'enable', 'true', '1'].includes(mode.toLowerCase())
            config.ping_mode = ai.pingMode
            try {
                globalThis._saveConfig?.(config)
            } catch {}
            return interaction.reply({
                content: `Ping mode **${ai.pingMode ? 'enabled' : 'disabled'}**`,
                flags: MessageFlags.Ephemeral,
            })
        }
    })

    // prefix commands for AI
    client.commands.set('p', async (msg, args) => {
        const text = args.join(' ')
        if (!text) return msg.reply('Please provide a prompt.')
        const uid = String(msg.author.id)
        ai.customPrompts[uid] =
            text + ' + You are Medusa. Respond as yourself in first person, a Discord bot and chatbot.'
        if (ai._promptSaveTimer) clearTimeout(ai._promptSaveTimer)
        ai._promptSaveTimer = setTimeout(() => {
            ai._saveJSON('Ai Database/custom_prompts.json', ai.customPrompts)
            ai._promptSaveTimer = null
        }, 500)
        await msg.reply(`✅ Custom prompt set for ${msg.author.displayName}`)
    })
    client.commands.set('prompt', client.commands.get('p'))
    client.commands.set('pr', async (msg) => {
        const uid = String(msg.author.id)
        if (ai.customPrompts[uid]) {
            delete ai.customPrompts[uid]
            ai._saveJSON('Ai Database/custom_prompts.json', ai.customPrompts)
            await msg.reply(`✅ Prompt reset to default for ${msg.author.displayName}`)
        } else await msg.reply("You don't have a custom prompt set.")
    })
    client.commands.set('mode', async (msg, args) => {
        const input = args[0]?.toLowerCase()
        const uid = String(msg.author.id)
        if (!input) {
            const cur = ai.userModes[uid] ?? 0
            return msg.reply(
                `Your current mode: **${cur === 1 ? 'focused' : 'normal'}** (${cur}). Use \`${PREFIX}mode focused\` or \`${PREFIX}mode normal\`.`,
            )
        }
        let newMode = null
        if (['focused', '1'].includes(input)) newMode = 1
        else if (['normal', '0'].includes(input)) newMode = 0
        else return msg.reply('❌ Invalid mode. Use `focused`/`1` or `normal`/`0`')

        ai.userModes[uid] = newMode
        // Async save with debounce to prevent disk thrashing
        if (ai._modeSaveTimer) clearTimeout(ai._modeSaveTimer)
        ai._modeSaveTimer = setTimeout(() => {
            ai._saveJSON('Ai Database/user_modes.json', ai.userModes)
            ai._modeSaveTimer = null
        }, 500)
        return msg.reply(`✅ Switched to **${newMode === 1 ? 'focused' : 'normal'} mode**`)
    })

    client.commands.set(
        'aipause',
        ownerOnly(async (msg) => {
            ai.paused = !ai.paused
            await msg.reply(`AI ${ai.paused ? 'paused' : 'unpaused'}`)
        }),
    )
    client.commands.set(
        'aireinit',
        ownerOnly(async (msg) => {
            ai._initGroq()
            await msg.reply(`Reinitialized. Success: ${!!ai._groq}`)
        }),
    )
    client.commands.set(
        'aiwipe',
        ownerOnly(async (msg) => {
            ai.messageHistory.clear()
            for (const m of [ai.globalMem, ...ai.isolatedMems.values()])
                try {
                    m.db.exec(
                        'DELETE FROM conversations; DELETE FROM interests; DELETE FROM personality; DELETE FROM users; DELETE FROM relationships; DELETE FROM user_aliases;',
                    )
                } catch {}
            await msg.reply('AI memory wiped')
        }),
    )
    client.commands.set(
        'aimodel',
        ownerOnly(async (msg, args) => {
            if (!args[0]) return msg.reply(`Current: \`${ai.aiModel}\``)
            ai.aiModel = args[0]
            config.aiModel = args[0]
            try {
                writeFileSync('config.json', JSON.stringify(config, null, 2))
            } catch {}
            await msg.reply(`Model set to: \`${args[0]}\``)
        }),
    )
    client.commands.set(
        'aiignore',
        ownerOnly(async (msg, args) => {
            const [action, user] = args
            if (!action) return msg.reply(`Ignored users: ${[...ai.ignoreUsers].join(', ') || 'none'}`)
            if (action === 'add') {
                if (user === 'all') {
                    ai.ignoreUsers.add('all')
                } else {
                    const id = user?.replace(/[<@!>]/g, '')
                    if (id) ai.ignoreUsers.add(id)
                }
                config.ignore_users = [...ai.ignoreUsers]
                try {
                    writeFileSync('config.json', JSON.stringify(config, null, 2))
                } catch {}
                await msg.reply('✅ Added')
            } else if (action === 'remove') {
                const id = user?.replace(/[<@!>]/g, '') ?? 'all'
                ai.ignoreUsers.delete(id)
                config.ignore_users = [...ai.ignoreUsers]
                try {
                    writeFileSync('config.json', JSON.stringify(config, null, 2))
                } catch {}
                await msg.reply('✅ Removed')
            } else if (action === 'clear') {
                ai.ignoreUsers.clear()
                config.ignore_users = []
                try {
                    writeFileSync('config.json', JSON.stringify(config, null, 2))
                } catch {}
                await msg.reply('✅ Cleared')
            }
        }),
    )
    client.commands.set(
        'aihistory',
        ownerOnly(async (msg, args) => {
            const uid = args[0] ?? msg.author.id
            const hist = ai.globalMem.getHistory(String(uid), parseInt(args[1]) || 5)
            if (!hist.length) return msg.reply(`No history for user ${uid}`)
            const lines = hist.map(
                (r, i) =>
                    `${i + 1}. User: ${r.message_content.slice(0, 100)}\n   AI: ${r.ai_response.slice(0, 100)}\n   Time: ${r.timestamp}`,
            )
            for (const chunk of ai.splitResponse(`**History for ${uid}:**\n${lines.join('\n\n')}`))
                await msg.reply(chunk)
        }),
    )
    client.commands.set(
        'aiclear',
        ownerOnly(async (msg, args) => {
            const uid = args[0]
            if (!uid) return msg.reply('Please provide a user ID.')
            for (const m of [ai.globalMem, ...ai.isolatedMems.values()])
                try {
                    m.wipeUser(uid)
                } catch {}
            ai._invalidateUserCache(uid)
            for (const k of [...ai.messageHistory.keys()])
                if (k.startsWith(`${uid}-`)) ai.messageHistory.delete(k)
            await msg.reply(`Cleared all data for user ${uid}`)
        }),
    )
    client.commands.set(
        'aianalyze',
        ownerOnly(async (msg, args) => {
            const uid = args[0] ?? msg.author.id
            const user = ai.globalMem.getUser(String(uid))
            if (!user) return msg.reply(`No data for user ID: ${uid}`)
            const ints = ai.globalMem.getInterests(String(uid))
            const lines = [
                `**Analysis for ${user.display_name} (${user.username})**`,
                `Conversations: ${user.conversation_count}`,
            ]
            if (ints.length)
                lines.push(
                    `Interests: ${ints
                        .slice(0, 3)
                        .map((r) => `${r.topic}(${r.frequency})`)
                        .join(', ')}`,
                )
            const query = args.slice(1).join(' ')
            if (query) {
                const hist = ai.globalMem.getHistory(String(uid), 3)
                const convTxt = hist.map((r) => `User: ${r.message_content}\nAI: ${r.ai_response}`).join('\n')
                const analysis = await ai.generateResponse({
                    prompt: `Analyze this user and answer: ${query}\nConversations:\n${convTxt}`,
                })
                if (analysis) lines.push(`**AI Analysis:**\n${analysis}`)
            }
            for (const chunk of ai.splitResponse(lines.join('\n\n'))) await msg.reply(chunk)
        }),
    )
    client.commands.set(
        'iso',
        ownerOnly(async (msg) => {
            if (!msg.guild) return
            ai.isolatedServers.add(msg.guild.id)
            ai.isolatedMems.set(msg.guild.id, new AIMemoryManager(msg.guild.id, msg.guild.name))
            config.isolated_servers = [...ai.isolatedServers]
            try {
                writeFileSync('config.json', JSON.stringify(config, null, 2))
            } catch {}
            await msg.reply(`✅ **${msg.guild.name}** isolated — separate AI memory.`)
        }),
    )
    client.commands.set(
        'uniso',
        ownerOnly(async (msg) => {
            if (!msg.guild) return
            ai.isolatedServers.delete(msg.guild.id)
            ai.isolatedMems.delete(msg.guild.id)
            config.isolated_servers = [...ai.isolatedServers]
            try {
                writeFileSync('config.json', JSON.stringify(config, null, 2))
            } catch {}
            await msg.reply(`✅ **${msg.guild.name}** un-isolated.`)
        }),
    )
    client.commands.set(
        'pm',
        ownerOnly(async (msg, args) => {
            const m = args[0]?.toLowerCase()
            if (!m) return msg.reply(`Ping mode: **${ai.pingMode ? 'enabled' : 'disabled'}**`)
            ai.pingMode = ['on', 'enable', 'true', '1'].includes(m)
            config.ping_mode = ai.pingMode
            try {
                writeFileSync('config.json', JSON.stringify(config, null, 2))
            } catch {}
            await msg.reply(`Ping mode **${ai.pingMode ? 'enabled' : 'disabled'}**`)
        }),
    )

    console.log('[AI] Manager initialized, listeners registered')
    return ai
}

// Additional slash commands to add to index.js registration
export function buildAISlashCommands() {
    return [
        new SlashCommandBuilder()
            .setName('lore')
            .setContexts(0)

            .setDescription('Manage server lore Medusa learns from')
            .addSubcommand((s) => s.setName('list').setDescription('View all recorded server lore'))
            .addSubcommand((s) =>
                s
                    .setName('add')
                    .setDescription('Add a lore fact (mods)')
                    .addStringOption((o) =>
                        o.setName('fact').setDescription('Fact to add (max 120 chars)').setRequired(true),
                    ),
            )
            .addSubcommand((s) =>
                s
                    .setName('remove')
                    .setDescription('Remove a lore entry (mods)')
                    .addIntegerOption((o) =>
                        o.setName('id').setDescription('ID from /lore list').setRequired(true),
                    ),
            )
            .addSubcommand((s) => s.setName('clear').setDescription('Clear all auto-extracted lore (mods)')),
        new SlashCommandBuilder()
            .setName('memory')
            .setDescription('See what Medusa remembers about you')
            .setContexts(0),
        new SlashCommandBuilder()
            .setName('forgetme')
            .setContexts(0)
            .setDescription('Delete everything Medusa remembers about you'),
        new SlashCommandBuilder()
            .setName('mode')
            .setContexts(0)
            .setDescription('Switch between focused/normal AI mode')
            .addStringOption((o) =>
                o
                    .setName('mode')
                    .setDescription('focused or normal')
                    .addChoices({ name: 'focused', value: 'focused' }, { name: 'normal', value: 'normal' }),
            ),
        new SlashCommandBuilder()
            .setName('ghost')
            .setContexts(0)
            .setDescription('Manage ghost user filter')
            .addSubcommand((s) =>
                s
                    .setName('add')
                    .setDescription('Ghost a user')
                    .addUserOption((o) =>
                        o.setName('user').setDescription('User to ghost').setRequired(true),
                    ),
            )
            .addSubcommand((s) =>
                s
                    .setName('remove')
                    .setDescription('Unghost a user')
                    .addUserOption((o) =>
                        o.setName('user').setDescription('User to remove').setRequired(true),
                    ),
            )
            .addSubcommand((s) => s.setName('list').setDescription('List ghosted users'))
            .addSubcommand((s) => s.setName('clear').setDescription('Clear ghost list')),
        // Owner-only (hidden by not setting defaultMemberPermissions, ephemeral responses guard access)
        new SlashCommandBuilder().setName('aipause').setDescription('Toggle AI pause (owner)').setContexts(0),
        new SlashCommandBuilder()
            .setName('aireinit')
            .setDescription('Reinitialize Groq client (owner)')
            .setContexts(0),
        new SlashCommandBuilder()
            .setName('aimodel')
            .setContexts(0)
            .setDescription('Get/set AI model (owner)')
            .addStringOption((o) => o.setName('model').setDescription('Model string')),
        new SlashCommandBuilder()
            .setName('aiwipe')
            .setDescription('Wipe all AI memory (owner)')
            .setContexts(0),
        new SlashCommandBuilder()
            .setName('pm')
            .setContexts(0)
            .setDescription('Toggle ping mode (owner)')
            .addStringOption((o) =>
                o
                    .setName('mode')
                    .setDescription('on or off')
                    .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }),
            ),
        new SlashCommandBuilder()
            .setName('iso')
            .setDescription('Isolate server AI memory (owner)')
            .setContexts(0),
        new SlashCommandBuilder()
            .setName('uniso')
            .setDescription('Un-isolate server AI memory (owner)')
            .setContexts(0),
        new SlashCommandBuilder()
            .setName('summarize')
            .setDescription('Summarize recent conversation')
            .setIntegrationTypes(0, 1)
            .setContexts(0, 1, 2)
            .addStringOption((o) => o.setName('start_from').setDescription('Message ID to start from')),
        new SlashCommandBuilder()
            .setName('medusa')
            .setDescription(
                'Quick Agent — stateless AI query, no memory, no commands. Works in DMs and any server.',
            )
            .setIntegrationTypes(0, 1)
            .setContexts(0, 1, 2)
            .addStringOption((o) =>
                o
                    .setName('prompt')
                    .setDescription('What do you want to ask?')
                    .setRequired(true)
                    .setMaxLength(1800),
            )
            .addBooleanOption((o) =>
                o.setName('search').setDescription('Force a live web search (default: auto-detect)'),
            )
            .addBooleanOption((o) =>
                o.setName('private').setDescription('Show only to you (ephemeral). Default: visible.'),
            ),
    ].map((c) => c.toJSON())
}
