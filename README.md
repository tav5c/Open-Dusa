> [!CAUTION]
> Open-Dusa uses LLM-driven tool calling and may behave unpredictably or go rogue. Use at your own risk.

<div align="center">

# 🐍 Open-Dusa

**The Agentic AI Resident for Discord**

[![Node.js](https://img.shields.io/badge/Node.js-20+-success?logo=node.js&logoColor=white)](#)
[![Discord.js](https://img.shields.io/badge/discord.js-v14-5865F2?logo=discord&logoColor=white)](#)
[![SQLite](https://img.shields.io/badge/SQLite-WAL-lightgrey?logo=sqlite&logoColor=white)](#)
[![License](https://img.shields.io/badge/License-MIT-green)](#)

_A Discord bot that doesn't just respond - it listens, remembers, and lives in your server._

</div>

---

## What makes this different

Most AI bots are stateless question machines. Open-Dusa is an **ambient AI resident**: she passively reads the room, tracks relationships, learns your server's culture, and responds with genuine contextual awareness - not because a timer fired, but because she actually noticed something.

The killer feature is the **Passive Memory Buffer**. Open-Dusa silently ingests the last 25 messages in every visible channel into an in-memory ring buffer. When she responds, her context window includes the live pulse of the conversation she's been witnessing - who said what, the energy level, the topic drift. The result looks uncannily like a person who's been lurking and finally chimed in.

---

## Architecture

Open-Dusa is built on three load-bearing ideas:

**1. Passive Buffer -> Context Injection**
A second `messageCreate` listener (separate from the AI handler) silently populates a per-channel ring buffer of the last 25 messages. Before every AI response, this buffer is injected into the system prompt as `RECENT CHANNEL ACTIVITY`. The buffer is purely in-memory - nothing is persisted - and it auto-expires entries older than 10 minutes.

**2. Agentic Memory (SQLite WAL)**  
Per-user and per-server data is stored in `better-sqlite3` databases running in Write-Ahead Logging mode. Tables include `conversations`, `interests`, `personality`, `relationships`, `user_aliases`, `server_lore`, and `user_summaries`. The `AIMemoryManager` class defers all writes through a 150ms flush queue to batch concurrent operations, and pre-prepares all hot SQL statements at init time. A background summarizer periodically folds each user's oldest conversations into a compact `user_summaries` note and deletes the raw rows - long-term context survives, the database doesn't bloat. Each database file also compacts itself (`VACUUM`) shortly after it loads and roughly once a day, on its own independent schedule so no two files ever block each other.

**3. Dynamic Extension Loader**  
Any `.js` file dropped into the `/extensions` directory is hot-loaded. Each extension can export `init()`, `handleMessage()`, and `handleInteraction()` hooks. The message pipeline runs each extension in order and stops early if any returns `true` (sinking the message). This is what makes the codebase forkable and composable.

---

## File Structure

```
open-dusa/
├── index.js                  - Gateway: client init, prefix router, slash commands
├── config.json               - Your config (edit directly before running)
├── configs/                  - Generated files: runtime.json, performance.json, callers.json, priv.json, timezones.json, .slash_hash
├── extensions/
│   ├── ai.js                 - AI extension entry: slash/prefix commands, client wiring
│   ├── ai/                   - The AI engine, split by concern:
│   │   ├── constants.js      - Routing signal lists, safety terms, capabilities contract
│   │   ├── memory.js         - SQLite pool, agentic memory + lore, ghost users
│   │   ├── providers.js      - Provider router, key rotation, circuit breakers
│   │   ├── research.js       - Web-search tool loop + needsResearch classifier
│   │   ├── vision.js         - Image/attachment understanding
│   │   ├── agent-commands.js - AI-invoked moderation: parsing, permission gates
│   │   ├── output.js         - Leak guard, degenerate checks, splitting, media
│   │   └── chat.js           - AIChatManager: context, triggers, generation pipeline
│   ├── config.js             - Config normalizer + runtime.json overlay (single source of truth)
│   ├── db.js                 - SQLite open helper with at-rest encryption (SQLCipher)
│   ├── heart.js              - System monitor, rate limiter, graceful shutdown
│   ├── moderation.js         - Full mod suite: ban/mute/warn/purge/logs
│   ├── afk.js                - AFK system with nick patching
│   ├── reminders.js          - Persistent reminders: natural-language + slash/prefix, restart-safe
│   ├── utils.js              - Shared helpers: parseTime, formatDuration, resolveTarget
│   └── myFeature.js          - Example extension template (safe to delete)
├── data/                     - Runtime data umbrella (auto-created, auto-migrated)
│   ├── ai/                   - Per-guild and global SQLite memory, prompts, modes, ghosts
│   └── logs/                 - Mod log DB + dead key tracking
└── package.json
```

> [!NOTE]
> The `.gitignore` also excludes `extensions/private.js`. This slot is reserved for personal extensions you don't want to publish. Drop any private feature file there and it won't be tracked.

---

## Quick Start

### 1. Prerequisites

- Node.js 20 or higher
- A Discord bot token ([Discord Developer Portal](https://discord.com/developers/applications))
- An LLM API key - Groq is recommended and has a free tier ([console.groq.com](https://console.groq.com))

### 2. Install

```bash
git clone https://github.com/your-username/Open-Dusa
cd Open-Dusa
npm install
```

### 3. Configure

```bash
cp config.json config.json.bak   # optional backup
# Then edit config.json directly with your token, owner ID, and API keys
```

### 4. Enable Privileged Intents

In the [Discord Developer Portal](https://discord.com/developers/applications), go to your bot (or create application) -> **Bot** tab ->

- Token > copy > paste in config.json,
  go to **Installation** tab ->
- Select **Guild** method then setup the install link with administrator permission then add to your server via the generated link.
    > [!IMPORTANT]
    > Enable Message Content Intent and Server Members Intent in the Discord Developer Portal before running the bot.

### 5. Run

```bash
npm start        # production
npm run dev      # development (auto-restart on file changes)
```

---

## Configuration Reference

```jsonc
{
    // ─── Bot Identity ─────────────────────────────────────────────────────────
    "token": "YOUR_BOT_TOKEN_HERE", // Discord bot token (required)
    "ownerId": "YOUR_DISCORD_ID", // Your user ID - grants owner-only commands
    "ownerName": "YourName", // How the AI refers to you in her lore
    "prefix": "med,", // Prefix for text commands
    "prefixAliases": [], // Optional extra prefixes, e.g. ["m.", "m,"] - the main prefix stays canonical in help text

    // ─── LLM Providers ───────────────────────────────────────────────────────
    // ONE list for every OpenAI-compatible credential (Groq, NVIDIA NIM,
    // OpenRouter…). Lowest priority number is tried first; the router falls
    // through on rate limits and outages, and keys within a provider rotate
    // automatically.
    "providers": [
        {
            "name": "groq",
            "baseUrl": "https://api.groq.com/openai/v1",
            "keys": ["gsk_YOUR_GROQ_KEY"],
            "model": "openai/gpt-oss-120b",
            "priority": 1
        },
        {
            "name": "nvidia",
            "baseUrl": "https://integrate.api.nvidia.com/v1",
            "keys": ["nvapi-YOUR_NVIDIA_KEY"],
            "model": "mistralai/mistral-small-4-119b-2603",
            "priority": 2
        }
    ],

    // ─── Agents - one shape for all five ───────────────────────────────────────
    // Every agent takes model / temperature / topP / maxTokens, plus an optional
    // "provider" (a name from providers[] - omit to use the highest-priority one)
    // and an optional systemPrompt (string, or array of lines joined by newlines).
    "agents": {
        "chat": {
            "provider": "groq",
            "model": "openai/gpt-oss-120b",
            "temperature": 0.9, // Chat creativity (0.0–2.0)
            "topP": 1.0,
            "maxTokens": 1024,
            "systemPrompt": "You are ...", // Her entire personality - better left as is
            "identity": "" // Facts that survive any persona swap (creator, links) - personas change her tune, not who she is
        },
        "research": {
            "provider": "groq",
            "model": "groq/compound-mini", // ⚠️ 250 RPD free-tier limit - research ONLY
            "temperature": 0.6, // Lower = more factual
            "topP": 1.0,
            "maxTokens": 1500
        },
        "vision": {
            "model": "meta-llama/llama-4-scout-17b-16e-instruct", // Image understanding
            "temperature": 0.4,
            "topP": 1.0,
            "maxTokens": 1024
        },
        "classifier": {
            // YES/NO routing - keep it small and fast. Defaults to your NIM provider
            // when one is configured so routing never eats the primary's daily tokens.
            "provider": "nvidia",
            "model": "meta/llama-3.1-8b-instruct"
        },
        "quickAgent": {
            // The /medusa slash command - stateless, no memory or lore
            "model": "", // Empty = use the chat model
            "temperature": 0.4,
            "topP": 0.9,
            "maxTokens": 1400,
            "allowResearch": true, // Whether /medusa can trigger web search
            "systemPrompt": [] // Array of lines (see config.json)
        }
    },
    "fallbackModels": [
        // Tried in order on 503 capacity errors
        "llama-3.3-70b-versatile",
        "qwen/qwen3-32b",
        "llama-3.1-8b-instant"
    ],

    // ─── Optional Integrations ───────────────────────────────────────────────
    "search": {
        "serperKey": "", // serper.dev - free tier: 2500 searches/month
        "tavilyKey": "" // tavily.com - fallback search provider
    },
    "giphyKey": "", // Giphy API key for GIF reactions (blank = free fallback)

    // ─── Behavior ────────────────────────────────────────────────────────────
    "triggers": "meddy,medusa,med", // Words that wake her up (comma-separated)
    "allowDMs": false, // Whether she responds to DMs
    "memoryDepth": 25, // Conversation turns included in history
    "funMsgInterval": 5400, // Seconds between unprompted messages (0 to disable)
    "stopSequences": [], // Extra stop sequences passed to the LLM
    "ignoreUsers": [], // User IDs the AI never responds to (edit here, config.json is the only source)

    // ─── Server Scope - one map instead of three parallel arrays ─────────────────
    // Empty map {} = prefix commands work everywhere. "ai": false disables the AI
    // in that server; "isolatedMemory": true gives it its own memory database.
    "guilds": {
        "YOUR_GUILD_ID": { "ai": true, "isolatedMemory": false }
    },
    "alwaysActiveChannels": [], // Channel IDs: AI always active (no trigger needed)
    "funChannels": [] // Channel IDs for unprompted messages
}
```

> [!IMPORTANT]
> **Migrating from an older config?** Nothing breaks: every legacy key (`owner_id`, `llm_base_url`/`llm_keys`, `research_base_url`/`research_key`, `aiModel`, `researchTemp`, `FunMsgInterval`, `ai_allowed_guilds`, `isolated_servers`, …) is still read by `extensions/config.js` and mapped onto the shape above, with a deprecation warning at boot. Runtime changes made via `/isolation` are saved to `configs/runtime.json`. The only things that touch `config.json` itself are `/ai-pause` (which adds or removes the per-server `"ai": false` flag) and `/configclean`.

> [!NOTE]
> `research_model` is intended for research-only use and is not suitable as the main chat model on the free tier.
> **Critical model note:** the research model (`groq/compound-mini`) has a hard limit of 250 requests/day on Groq's free tier. If you set it as the chat model, the bot will exhaust its quota in hours. Keep it research-only.

> [!TIP]
> **Recommended stack:** NVIDIA NIM for chat (`mistralai/mistral-small-4-119b-2603`) + Groq compound-mini for research + Serper.dev for live web search results. Get a free Serper key at [serper.dev](https://serper.dev) (2500 searches/month, no card needed).

> [!TIP]
> **Multi-provider setup:** list every provider in `providers[]`, then pin agents where you want them: `"agents": { "chat": { "provider": "nvidia" }, "research": { "provider": "groq" } }`. Agents without a `provider` use the highest-priority entry, and everything falls back gracefully if a provider is down.

---

## Performance Tuning

Open-Dusa ships with safe defaults suitable for cheap shared hosts (256 MB RAM, shared CPU). If you're running on a VPS with more headroom, edit `configs/performance.json` to override any of these knobs.

On first startup, if `configs/performance.json` doesn't exist, the bot auto-creates it with defaults. Edit and restart to apply.

```jsonc
{
  "sqlite": {
    "cacheSizeKB": 20000,           // SQLite page cache (20 MB -> raise to 100 MB on a VPS)
    "mmapSizeBytes": 67108864,      // mmap I/O window (64 MB -> 512 MB if you have RAM)
    "journalSizeLimit": 4096000,    // WAL ceiling (4 MB) - rarely worth tuning
    "walAutocheckpoint": 5000       // Checkpoint every N pages
  },
  "discord": {
    "messageCache": 100,            // Messages cached per channel
    "memberCacheMax": 200,          // Guild members cached per guild
    "userCache": null,              // Set to a number (e.g. 5000) to cache more user objects
    "messageSweepInterval": 300,    // seconds between sweeps
    "messageSweepLifetime": 900     // seconds before a cached message is eligible for eviction
  },
  "ai": {
    "responseCacheMax": 512,        // Entries in the LLM response cache
    "responseCacheTTLSec": 300,
    "responseCacheMaxMB": 20,       // Hard size ceiling for the response cache
    "userCacheMax": 500,            // Per-user context cache (entries)
    "userCacheTTLSec": 120,
    "messageHistoryMax": 200,       // Active conversations retained in memory
    "messageHistoryTTLMin": 30,
    "repliedMsgCacheMax": 500,
    "repliedMsgCacheTTLMin": 10,
    "memoryDepth": 25,              // How many turns of history injected into prompts
    "passiveBufferMax": 25,         // Recent messages per channel retained for room-awareness
    "passiveBufferChannelsMax": 500 // Total channels tracked (prevents RAM bloat at scale)
  },
  "maintenance": {
    "cleanupIntervalMin": 10,       // How often periodic cleanup runs
    "retentionDays": 30,            // Keep conversation history this long in SQLite
    "vacuumEveryDays": 7,           // VACUUM gate - weekly by default (expensive op)
    "loopLagWarnMs": 500            // Warn when Node event loop lag exceeds this
  }
}

{
  "sqlite":      { "cacheSizeKB": 100000, "mmapSizeBytes": 536870912 },
  "discord":     { "messageCache": 500, "memberCacheMax": 2000, "userCache": 5000, "messageSweepLifetime": 1800 },
  "ai":          { "responseCacheMax": 4096, "responseCacheTTLSec": 600, "responseCacheMaxMB": 100,
                   "userCacheMax": 5000, "userCacheTTLSec": 300,
                   "messageHistoryMax": 1000, "messageHistoryTTLMin": 120,
                   "repliedMsgCacheMax": 2000, "repliedMsgCacheTTLMin": 30,
                   "memoryDepth": 50, "passiveBufferMax": 50, "passiveBufferChannelsMax": 1500 },
  "maintenance": { "cleanupIntervalMin": 30, "retentionDays": 180, "loopLagWarnMs": 200 }
}

npm run start:beefy    # 3 GB heap, 16 UV threads - good for 2-4 GB VPS
npm run start:max      # 6 GB heap, 24 UV threads - 8 GB+ hosts

---

## Slash Commands

| Command                        | Description                                                      | Who                     |
| ------------------------------ | ---------------------------------------------------------------- | ----------------------- |
| `/memory`                      | View what Open-Dusa remembers about you                          | Everyone                |
| `/forgetme`                    | Permanently delete your stored data                              | Everyone                |
| `/mode`                        | Switch between `focused` (analytical) and `normal` (casual) mode | Everyone                |
| `/summarize`                   | Summarize recent channel conversation                            | Everyone (rate-limited) |
| `/medusa`                      | Quick one-shot AI answer. No memory. DMs and group chats only.   | Everyone                |
| `/ban`, `/mute`, `/warn`, etc. | Standard moderation suite                                        | Mods                    |
| `/ai-pause pause/resume`       | Pause or resume the AI in this server (saved to config.json)     | Admins                  |
| `/isolation true/false`        | Give a server its own AI memory (resumable)                      | Owner                   |
| `/configclean`                 | Sweep dead server/channel ids out of config.json                 | Owner                   |

## Prefix Commands (`med,`)

Every command below also works with any alias you add to `prefixAliases` in `config.json`.

```
med,p <prompt>        - Set a custom AI persona just for you
med,pr                - Reset to default persona
med,serverp <prompt>  - Set a server-wide persona (needs Manage Server)
med,serverpr          - Reset the server persona
med,mode focused/normal
med,afk [reason]      - Go AFK with a timestamped reason
med,unafk
med,ping / med,stats / med,menu
med,ban / med,mute / med,warn / med,clear / med,mpurge
med,remind <1h30m|ISO datetime> <text>  - Set a reminder (units: s/m/h/d/w, or an exact date/time)
```

> [!NOTE]
> The prefix `remind` command only accepts a duration or ISO datetime as its first token - it doesn't parse natural language. Mention Medusa instead (`@Medusa remind me to... in 20m`) to set one conversationally; she extracts the timing herself and confirms with a real timestamped reminder line, not just a reply.

---

## Writing Extensions

The extension API is the fastest way to add features without touching core files.

```javascript
// extensions/myFeature.js

// Called once on startup. Receives the live client, db, and heart.
export function init(client, db, heart) {
    console.log('[myFeature] Loaded!')

    // Register a prefix command dynamically
    client.commands.set('hello', async (msg) => {
        await msg.reply('world!')
    })
}

// Runs on every message before prefix routing.
// Return true to "sink" the message (stops all further processing).
// Return false/undefined to let it pass through.
export async function handleMessage(message) {
    if (message.content === 'ping') {
        await message.reply('pong')
        return true // sink - AI won't see this
    }
    return false
}

// Runs on every slash command interaction.
// Return true if you handled it, false/undefined to pass through.
export async function handleInteraction(interaction) {
    if (interaction.commandName !== 'mycommand') return false
    await interaction.reply('handled!')
    return true
}
```

Drop the file in `/extensions/` and restart. That's it.

**What extensions get access to:**

- `client` - the full Discord.js Client, including `client.commands` (prefix map) and `client.aiCog` (AI manager)
- `db` - the main SQLite database (mod logs, warnings)
- `heart` - the system monitor: `heart.rateLimiter`, `heart.cache` (LRU), `heart.monitor` (CPU/RAM/lag)
    > [!TIP]
    > The dynamic extension loader makes it easy to add features without touching core files and causing critical issues which makes the project easier to maintain.

---

## AI System Design

### Research Routing

Every incoming message goes through a classifier before hitting the main LLM:

```
message -> needsResearch()
    ├─ ALWAYS_LIVE keywords  -> "research"  (price, weather, news, etc.)
    ├─ NEVER_RESEARCH signals -> "direct"   (vibes, greetings, emotional)
    ├─ NO_SEARCH signals     -> "nosearch"  (explicitly told not to search)
    ├─ NSFW/dangerous terms  -> blocked
    └─ ambiguous             -> classifier LLM (YES/NO, 2.5s timeout)
```

The classifier uses a cheap fast model to avoid burning chat quota on conversational messages. When an NVIDIA NIM provider is configured it rides that by default (`meta/llama-3.1-8b-instruct`) so routing calls never touch the primary provider's daily token budget; otherwise it falls back to `llama-3.1-8b-instant` on the primary. The 2.5s classification timeout means a slow round-trip can never block a reply.

### Key Rotation

Keys within each `providers[]` entry rotate automatically on 429/401/403 key errors, and the router falls through to the next provider when one is rate-limited or down. Cooldowns prefer the provider's `retry-after` header and fall back to the `try again in ...` window from the error body, so a daily-limit (TPD) key sits out until it's actually usable again instead of ping-ponging on a flat 30s timer. Request errors such as 400/413/422 and capacity errors such as 498/503/529 never burn through the key ring because changing credentials cannot fix the request or provider capacity. Rotation logs include the HTTP reason and cooldown, making a real all-account quota sweep distinguishable from a bad request. When one key gets limited the router immediately retries the same provider on its next free key; only when every key is cooling down does the circuit open, and it opens until the soonest key frees up (capped at 30 min) rather than a blind 60s. Keys are permanently blacklisted (`dead_keys.json`) only on organization-level errors (account suspended, org restricted). A transient 401 (expired token) rotates to the next key but doesn't blacklist - the key returns to rotation after restart. Duplicate keys in the array are dropped at load (they'd share the same org quota anyway), and the boot log prints each provider's key count so a mispasted pool is visible immediately.

### Confirmation Gate

Destructive agentic commands (`ban`, `mute`, `clear`, `purge`) require explicit user confirmation before executing:

1. AI decides to mute someone -> emits `<<RUN_CMD: mute 123456789 1h reason>>`
2. Bot intercepts it, stores pending, asks: _"Confirm mute on @user for 1h? Reply yes within 30s"_
3. User replies `yes` -> command fires -> `✅` react
4. No reply within 35s -> pending expires silently

### Action Self-Check

The capabilities contract (and its `RUN_CMD` syntax) is only injected into the prompt when the message plausibly needs it - a keyword gate keyed off the action verbs she actually supports, `remind`/`reminder` included. This keeps casual chat cheap to generate, but it means any command verb missing from that keyword list would silently fall back to prose instead of a real action for that turn.

As a second layer, whenever she does decide to run one or more commands, she's asked to self-report the number of actions she intended via a hidden `<<ACTIONS_INTENDED: N>>` tag. If the number of `RUN_CMD` tags actually parsed doesn't match, a visible heads-up note is appended so a dropped action never fails silently.

### Memory Architecture

```
Global memory (default)          Isolated memory (per /isolation guild)
    data/ai/                         data/ai/GuildName - GuildID/
    └── memory.db                    └── memory.db
         ├── users                        └── (same schema)
         ├── conversations
         ├── interests
         ├── personality
         ├── relationships          Main DB (logs/)
         ├── user_aliases           └── medusa.db
         └── server_lore                 ├── mod_logs
                                         ├── warnings
                                         └── reaction_roles
```

Servers with `"isolatedMemory": true` in the `guilds` map (or isolated live with `/isolation`) get their own memory database, so she maintains completely separate relationship graphs and lore for each. Un-isolating keeps the folder on disk; isolating the same server again picks the old database back up.

---

## Features At a Glance

### What she already does

**Memory & Awareness**

- Cross-session callbacks: occasionally surfaces old topics ("last time you mentioned X...")
- Relationship graph: tracks who talks to who, references them naturally
- Server lore: auto-extracted from conversation, she weaves it in organically
- User modes: `focused` mode drops the persona for analytical work  
- Quick Agent (`/medusa`): stateless slash command - user-installable, DMs and group chats only, no memory, no tools, dedicated tuning in `config.quickAgent`

**Agentic Actions**

- Runs Discord actions autonomously: fetch avatars/banners, create polls/threads, set slowmode, move users in VC, pin messages, manage channels
- Persistent reminders: set naturally in conversation or via `remind`/`reminder`/`remindme`, survive restarts, poll every 15s
- All destructive actions go through the confirmation gate
- Permission-gated: only fires commands the triggering user has permission to run

**Moderation Suite**

- Slash + prefix: `ban`, `unban`, `mute`, `unmute`, `warn`, `warnings`, `modlog`, `clearwarns`, `clear`, `erase` (`med,mpurge`), `sweep` (`med,fpurge`)
- Automod: anti-spam (configurable threshold), anti-caps (>70% uppercase), anti-links (with whitelist)
- DM notifications sent to targets before action lands

**Expressive Media**

- Tone-matched sticker and GIF reactions (40% chance when triggered)
- Falls back to free anime GIF API (nekos.best) if no Giphy key
- Hard-blocked on moderation and NSFW responses

**System**

- Health endpoint: `GET :8080/` -> `{status, uptime, guilds, ping, memory}`
- Paginated mod log viewer with button navigation
- Configurable fun messages with weighted roast/fact/philosophical types
- AFK system with nickname prefixing and mention notifications

---

## Deployment & Hosting

Open-Dusa is built to survive on cheap shared hosts, VPS boxes, and container platforms. Here is what you need to know for each environment.

### Shared Hosting / Pterodactyl / Ephemeral Storage

- **SQLite WAL mode** is enabled by default. The `-wal` and `-shm` files are normal and required while the bot is running.
- If your host wipes the working directory on restart, place `data/` on a persistent mount (e.g., `/home/container/persist/`). Change the paths in `config.json` if your host requires it.
- The bot auto-checks disk space. If you see `[Heart] DISK ALMOST FULL`, clear old logs or reduce `journal_size_limit`.

### Docker

````dockerfile
FROM node:20-alpine
RUN apk add --no-cache python3 make g++  # for better-sqlite3 native builds
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
CMD ["npm", "start"]

Config is file-based (`config.json`) but the bot token can also be passed as an environment variable:

```bash
TOKEN=your_token_here npm start
````

The health server port can be overridden:

```bash
HEALTH_PORT=3000 npm start
```

## Database Maintenance

Open-Dusa uses SQLite with WAL mode. Over months of heavy use, the database files can fragment. Here's how to keep them lean:

| Task           | Command                     | When                                               |
| -------------- | --------------------------- | -------------------------------------------------- |
| Full compact   | Automatic (startup + daily) | Every database vacuums itself, nothing to run      |
| Check size     | `ls -lh data/ai/ data/logs/` | Weekly                                             |
| WAL cleanup    | Automatic every 5 minutes   | Always running                                     |
| Auto-prune     | Automatic every 10 minutes  | Deletes conversations/interests older than 30 days |

**What gets pruned automatically:**

- Conversations, interests, personality, aliases, relationships: 30 days of inactivity
- Mod logs, resolved warnings: 180 days (configurable in `index.js`)
- Reaction roles: 90 days
- Orphaned guild data: when no logs/warnings reference the guild

**What grows forever (intentionally):**

- Active warnings (`active = TRUE`) - must be cleared via `/clearwarns`
- Server lore - auto-extracted only, clear it by deleting the memory database
- Custom prompts & user modes - per-user files, negligible size

## Troubleshooting

| Symptom                                    | Cause                                                  | Fix                                                                                                                                     |
| ------------------------------------------ | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `SQLITE_IOERR_SHMSIZE` on start            | Host doesn't allow shared-memory files                 | Already handled - the bot forces `locking_mode = EXCLUSIVE` to avoid `-shm`                                                             |
| `SQLITE_FULL` errors                       | Disk quota exceeded on host                            | The bot auto-truncates WAL every 5 min. Free up disk or move DB to a larger partition.                                                  |
| Bot starts but doesn't respond to mentions | `Message Content Intent` disabled                      | Enable it in the [Discord Developer Portal](https://discord.com/developers/applications) -> Bot -> Privileged Gateway Intents             |
| High memory usage over time                | Normal - LRU caches grow to their limits               | The bot auto-cleans every 10 min. If RSS exceeds ~400MB, check `[Heart] MEMORY LEAK` warnings.                                          |
| `better-sqlite3` install fails             | Missing build tools                                    | Run `npm install --build-from-source` or install `python3`, `make`, and `g++`                                                           |
| `npm start` crashes immediately            | Missing native build toolchain for `better-sqlite3@12` | Install `python3`, `make`, `g++` (Alpine: `apk add python3 make g++`), then `npm rebuild better-sqlite3`. Node 20–24 are all supported. |

---

## 🔐 Encryption at Rest

Open-Dusa can encrypt every SQLite database on disk using **SQLCipher** (via `better-sqlite3-multiple-ciphers`, installed automatically).

- Set a passphrase in the **`DB_ENCRYPTION_KEY`** environment variable (e.g. in your Pterodactyl *Startup* variables, or your shell/systemd env). Keep it secret and out of version control.
- A **`.env`** file in the project root also works - the config loader reads it at boot with no extra dependency. One `KEY=value` per line, `#` comments allowed; real environment variables always take precedence:

    ```bash
    # generate a 256-bit key
    node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
    # .env
    DB_ENCRYPTION_KEY=<paste the 64-char hex string>
    ```

- **Losing the key means losing the database** ��� there is no recovery. Back it up somewhere off-server. Changing the key (or removing it) will NOT re-encrypt an existing DB: the bot will refuse to open it and tell you why. To rotate keys or encrypt an existing plaintext DB, use a one-time SQLCipher rekey/export, or delete the `.db` files and let the bot rebuild fresh.
- On the first start after setting the key, the bot **transparently migrates** any existing plaintext databases to encrypted ones and leaves a `*.plain-bak` backup of each original. **Delete those `.plain-bak` files once you've confirmed the bot works** - they are unencrypted.
- If `DB_ENCRYPTION_KEY` is unset, the bot runs with plaintext storage (unchanged behavior), so existing self-hosters are unaffected.
- Don't lose the key: without it, encrypted databases cannot be opened.

## 🔒 Privacy Policy

> [!IMPORTANT]
> This policy covers the publicly hosted **Medusa** instance of Open-Dusa. Self-hosted forks are operated independently by whoever runs them, and that operator is the data controller for their own instance.

### What data is collected

| Data | Why | When |
| --- | --- | --- |
| **Message content** | To understand requests and generate relevant AI replies, and to maintain short-term conversational memory | Only from messages that engage Medusa (a mention, a reply to her, or a `med,` prefix command), plus a volatile in-memory buffer of recent channel activity used purely for live context |
| **Account data** (user ID, username, display name, avatar URL) | To address users by their server nickname and attribute moderation actions | On interaction |
| **Derived data** (inferred interests, relationship strength, personality notes, per-server "lore") | To make responses contextually aware | Generated from interactions |
| **Moderation data** (mod-log entries, warnings) | To operate moderation features | On moderator action |

### What is NOT collected

- **No presence/status data**, **no voice audio**, and **no bulk message scraping** - the live channel buffer is in-memory only, auto-expires after 10 minutes, and is never persisted.
- Data is **never sold or shared**. Message context is sent to the configured LLM provider (e.g., Groq) **solely to generate a reply** - it is **not used to train any model**.

### How it's stored

All persistent data lives in **SQLite databases on the bot operator's own server** - never on Discord's infrastructure. Data is **encrypted at rest**.

### Retention

- Conversations, interests, personality, aliases, and relationships: **auto-deleted after 30 days of inactivity**.
- Moderation logs and resolved warnings: 180 days.
- The in-memory channel buffer: ~10 minutes.

### Your rights & how to delete your data

- **`/forgetme`** - any user can permanently wipe **all** of their stored data (conversations, profile, interests, relationships, aliases) at any time.
- Server-level wipes are handled by the operator (deleting that server's memory database folder).
- Questions or deletion requests can also be sent to the bot operator via the **`/mail`** command.

### Changes

This policy may be updated over time; material changes will be reflected in this document.

---

## License

> [!NOTE]
> MIT - fork it, modify it, ship it. A credit back would be appreciated but isn't required.

Built by [Tav](https://tav5c.github.io/) · Open-sourced as Open-Dusa
