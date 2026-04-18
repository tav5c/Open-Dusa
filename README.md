> [!CAUTION]
> Open-Dusa uses LLM-driven tool calling and may behave unpredictably or go rogue. Use at your own risk.

<div align="center">

# 🐍 Open-Dusa

**The Agentic AI Resident for Discord**

[![Node.js](https://img.shields.io/badge/Node.js-18+-success?logo=node.js&logoColor=white)](#)
[![Discord.js](https://img.shields.io/badge/discord.js-v14-5865F2?logo=discord&logoColor=white)](#)
[![SQLite](https://img.shields.io/badge/SQLite-WAL-lightgrey?logo=sqlite&logoColor=white)](#)
[![License](https://img.shields.io/badge/License-MIT-green)](#)

*A Discord bot that doesn't just respond — it listens, remembers, and lives in your server.*

</div>

---

## What makes this different

Most AI bots are stateless question machines. Open-Dusa is an **ambient AI resident**: she passively reads the room, tracks relationships, learns your server's culture, and responds with genuine contextual awareness — not because a timer fired, but because she actually noticed something.

The killer feature is the **Passive Memory Buffer**. Open-Dusa silently ingests the last 25 messages in every visible channel into an in-memory ring buffer. When she responds, her context window includes the live pulse of the conversation she's been witnessing — who said what, the energy level, the topic drift. The result looks uncannily like a person who's been lurking and finally chimed in.

---

## Architecture

Open-Dusa is built on three load-bearing ideas:

**1. Passive Buffer → Context Injection**  
A second `messageCreate` listener (separate from the AI handler) silently populates a per-channel ring buffer of the last 25 messages. Before every AI response, this buffer is injected into the system prompt as `RECENT CHANNEL ACTIVITY`. The buffer is purely in-memory — nothing is persisted — and it auto-expires entries older than 10 minutes.

**2. Agentic Memory (SQLite WAL)**  
Per-user and per-server data is stored in `better-sqlite3` databases running in Write-Ahead Logging mode. Tables include `conversations`, `interests`, `personality`, `relationships`, `user_aliases`, and `server_lore`. The `AIMemoryManager` class defers all writes through a 150ms flush queue to batch concurrent operations, and pre-prepares all hot SQL statements at init time.

**3. Dynamic Extension Loader**  
Any `.js` file dropped into the `/extensions` directory is hot-loaded. Each extension can export `init()`, `handleMessage()`, and `handleInteraction()` hooks. The message pipeline runs each extension in order and stops early if any returns `true` (sinking the message). This is what makes the codebase forkable and composable.

---

## File Structure

```
open-dusa/
├── index.js                  — Gateway: client init, prefix router, slash commands
├── config.json               — Your config (edit directly before running)
├── extensions/
│   ├── ai.js                 — Core AI engine (AIChatManager + AIMemoryManager)
│   ├── heart.js              — System monitor, rate limiter, graceful shutdown
│   ├── moderation.js         — Full mod suite: ban/mute/warn/purge/logs
│   ├── automod.js            — Anti-spam, anti-caps, anti-links
│   ├── afk.js                — AFK system with nick patching
│   ├── utils.js              — Shared helpers: parseTime, formatDuration, resolveTarget
│   └── myFeature.js          — Example extension template (safe to delete)
├── Ai Database/              — Per-guild and global SQLite memory (auto-created)
├── Logs/                     — Mod log DB + dead key tracking (auto-created)
└── package.json
```

> [!NOTE]
> The `.gitignore` also excludes `extensions/private.js`. This slot is reserved for personal extensions you don't want to publish. Drop any private feature file there and it won't be tracked.

---

## Quick Start

### 1. Prerequisites

- Node.js 18 or higher
- A Discord bot token ([Discord Developer Portal](https://discord.com/developers/applications))
- An LLM API key — Groq is recommended and has a free tier ([console.groq.com](https://console.groq.com))

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

In the [Discord Developer Portal](https://discord.com/developers/applications), go to your bot (or create application) → **Bot** tab → 
- Token > copy > paste in config.json,
go to **Installation** tab →
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
  // ─── Bot Identity ───────────────────────────────────────────────────────────
  "token": "YOUR_BOT_TOKEN_HERE",        // Discord bot token (required)
  "owner_id": "YOUR_DISCORD_ID",         // Your user ID — grants owner-only commands
  "owner_name": "YourName",              // How the AI refers to you in her lore

  // ─── LLM Provider ───────────────────────────────────────────────────────────
  "llm_base_url": "https://api.groq.com/openai/v1",  // Any OpenAI-compatible endpoint
  "llm_keys": [                           // Rotated automatically on rate limits
    "gsk_YOUR_KEY_1",
    "gsk_YOUR_KEY_2"
  ],

  // ─── Model Stack ────────────────────────────────────────────────────────────
  // Recommended Groq models (free tier available):
  "aiModel": "openai/gpt-oss-120b",          // Primary chat model
  "research_model": "groq/compound-mini",             // ⚠️ 250 RPD limit — research ONLY
  "vision_model": "meta-llama/llama-4-scout-17b-16e-instruct",  // Image understanding
  "classifier_model": "llama-3.1-8b-instant",         // YES/NO routing classifier
  "fallback_models": [                                // Used on 503 capacity errors
    "llama-3.3-70b-versatile",
    "qwen/qwen3-32b",
    "llama-3.1-8b-instant"
  ],

  // ─── Generation Parameters ──────────────────────────────────────────────────
  "temperature": 0.9,      // Chat creativity (0.0–2.0)
  "topP": 1.0,             // Nucleus sampling
  "chatTokens": 1024,      // Max tokens for chat responses

  "researchTemp": 0.6,     // Research model temperature (lower = more factual)
  "searchTokens": 1500,    // Max tokens for research responses

  "visionTemp": 0.4,       // Vision model temperature
  "visionTokens": 1024,     // Max tokens for vision responses

  // ─── Personality ────────────────────────────────────────────────────────────
  "triggers": "meddy,medusa,med",  // Words that wake her up (comma-separated)
  "systemPrompt": "You are ...",   // Full system prompt — her entire personality (better to leave as is or just modify lightly)

  // ─── Optional Integrations ──────────────────────────────────────────────────
  "giphyKey": "",    // Giphy API key for GIF reactions (leave blank to use free fallback)

  // ─── Behavior Flags ─────────────────────────────────────────────────────────
  "allowDMs": false,        // Whether she responds to DMs
  "memoryDepth": 25,        // How many conversation turns to include in history
  "FunMsgInterval": 5400,   // Seconds between unprompted messages (0 to disable)

  // ─── Server Scope ───────────────────────────────────────────────────────────
  // Leave arrays empty [] to allow all servers
  "guilds": [],                    // Servers where prefix commands work
  "ai_allowed_guilds": [],         // Servers where AI responds (subset of guilds)
  "always_active_channels": [],    // Channel IDs: AI always active here (no trigger needed)
  "fun_channels": [],              // Channel IDs for unprompted messages
  "isolated_servers": []           // Server IDs with their own separate AI memory
}
```
> [!NOTE]
> `research_model` is intended for research-only use and is not suitable as the main chat model on the free tier.
> **Critical model note:** `research_model` (`groq/compound-mini`) has a hard limit of 250 requests/day on Groq's free tier. If you set it as `aiModel`, the bot will exhaust its quota in hours. Keep it research-only.

---

## Slash Commands

| Command | Description | Who |
|---|---|---|
| `/memory` | View what Open-Dusa remembers about you | Everyone |
| `/forgetme` | Permanently delete your stored data | Everyone |
| `/mode` | Switch between `focused` (analytical) and `normal` (casual) mode | Everyone |
| `/summarize` | Summarize recent channel conversation | Everyone (rate-limited) |
| `/lore list` | View all recorded server lore | Everyone |
| `/lore add` | Add a server lore fact she'll reference | Mods |
| `/lore remove` | Remove a lore entry by ID | Mods |
| `/lore clear` | Clear all auto-extracted lore | Mods |
| `/ghost add/remove/list/clear` | Control which users influence your AI context | Everyone |
| `/automod` | Configure anti-spam, anti-caps, anti-links | Mods |
| `/ban`, `/mute`, `/warn`, etc. | Standard moderation suite | Mods |
| `/aipause` | Toggle AI on/off | Owner |
| `/aimodel` | Get/set the current LLM model | Owner |
| `/iso` / `/uniso` | Isolate/un-isolate server memory | Owner |

## Prefix Commands (`med,`)

```
med,p <prompt>        — Set a custom AI persona just for you
med,pr                — Reset to default persona
med,mode focused/normal
med,afk [reason]      — Go AFK with a timestamped reason
med,unafk
med,ping / med,stats / med,menu
med,ban / med,mute / med,warn / med,clear / med,mpurge
```

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
        return true   // sink — AI won't see this
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
- `client` — the full Discord.js Client, including `client.commands` (prefix map) and `client.aiCog` (AI manager)
- `db` — the main SQLite database (mod logs, warnings, automod settings)
- `heart` — the system monitor: `heart.rateLimiter`, `heart.cache` (LRU), `heart.monitor` (CPU/RAM/lag)
> [!TIP]
> The dynamic extension loader makes it easy to add features without touching core files and causing critical issues which makes the project easier to maintain.
---

## AI System Design

### Research Routing

Every incoming message goes through a classifier before hitting the main LLM:

```
message → needsResearch()
    ├─ ALWAYS_LIVE keywords  → "research"  (price, weather, news, etc.)
    ├─ NEVER_RESEARCH signals → "direct"   (vibes, greetings, emotional)
    ├─ NO_SEARCH signals     → "nosearch"  (explicitly told not to search)
    ├─ NSFW/dangerous terms  → blocked
    └─ ambiguous             → classifier LLM (YES/NO, 2.5s timeout)
```

The classifier uses a cheap fast model (`llama-3.1-8b-instant`) to avoid burning research quota on conversational messages.

### Key Rotation

Keys in `llm_keys` rotate automatically on 429/401 errors. Keys are permanently blacklisted (`dead_keys.json`) only on organization-level errors (account suspended, org restricted). A transient 401 (expired token) rotates to the next key but doesn't blacklist — the key returns to rotation after restart.

### Confirmation Gate

Destructive agentic commands (`ban`, `mute`, `clear`, `purge`) require explicit user confirmation before executing:

1. AI decides to mute someone → emits `<<RUN_CMD: mute 123456789 1h reason>>`
2. Bot intercepts it, stores pending, asks: *"Confirm mute on @user for 1h? Reply yes within 30s"*
3. User replies `yes` → command fires → `✅` react
4. No reply within 35s → pending expires silently

### Memory Architecture

```
Global memory (default)          Isolated memory (per /iso guild)
    Ai Database/                     Ai Database/GuildName - GuildID/
    └── memory.db                    └── memory.db
         ├── users                        └── (same schema)
         ├── conversations
         ├── interests
         ├── personality
         ├── relationships          Main DB (logs/)
         ├── user_aliases           └── medusa.db
         └── server_lore                 ├── mod_logs
                                         ├── warnings
                                         ├── automod_settings
                                         └── reaction_roles
```

Servers added to `isolated_servers` get their own memory database, so she maintains completely separate relationship graphs and lore for each.

---

## Features At a Glance

### What she already does

**Memory & Awareness**
- Cross-session callbacks: occasionally surfaces old topics ("last time you mentioned X...")  
- Relationship graph: tracks who talks to who, references them naturally  
- Server lore: mods feed her facts via `/lore add`, she uses them organically  
- Ghost list: users can hide specific people from their AI context (`/ghost add`)  
- User modes: `focused` mode drops the persona for analytical work  

**Agentic Actions**
- Runs Discord actions autonomously: fetch avatars/banners, create polls/threads, set slowmode, move users in VC, pin messages, manage channels
- All destructive actions go through the confirmation gate  
- Permission-gated: only fires commands the triggering user has permission to run  

**Moderation Suite**
- Slash + prefix: `ban`, `unban`, `mute`, `unmute`, `warn`, `warnings`, `modlog`, `clearwarns`, `clear`, `mpurge`, `fpurge`, `filter_purge`  
- Automod: anti-spam (configurable threshold), anti-caps (>70% uppercase), anti-links (with whitelist)  
- DM notifications sent to targets before action lands  

**Expressive Media**
- Tone-matched sticker and GIF reactions (40% chance when triggered)  
- Falls back to free anime GIF API (nekos.best) if no Giphy key  
- Hard-blocked on moderation and NSFW responses  

**System**
- Health endpoint: `GET :8080/` → `{status, uptime, guilds, ping, memory}`  
- Paginated mod log viewer with button navigation  
- Configurable fun messages with weighted roast/fact/philosophical types  
- AFK system with nickname prefixing and mention notifications  

---

## Environment Variables

Config is file-based (`config.json`) but the bot token can also be passed as an environment variable:

```bash
TOKEN=your_token_here npm start
```

The health server port can be overridden:

```bash
HEALTH_PORT=3000 npm start
```

---

## License
> [!NOTE]
> MIT — fork it, modify it, ship it. A credit back would be appreciated but isn't required.

Built by [Tav](https://tav5c.github.io/) · Open-sourced as Open-Dusa