// Shared AI constants: routing signal lists, safety term sets, and the agent
// capabilities contract injected into the system prompt.
import { LRUCache } from 'lru-cache'

const DEAD_KEYS_FILE = 'data/logs/dead_keys.json'
const GHOST_FILE = 'data/ai/ghost_users.json'
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
    'research',
    'do research',
    'deep research',
    'search ',
    'search up',
    'search for',
    'can you find',
    'could you find',
    'look up',
    'look it up',
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
    'hii ',
    'hey ',
    'heyo',
    'hiya',
    'howdy',
    'salut',
    'ho ',
    'ho,',
    'yo ',
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
    'without researching',
    'no research',
    "don't research",
    'dont research',
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
    // User profile / appearance, resolved via RUN_CMD, not web
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

// Word-boundaried matcher for the NSFW set. Substring matching here false-fired
// on innocent words ("hololive" contains "loli", "lolita" too) and refused whole
// queries. Standalone terms still match exactly as before.
const _escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const NSFW_RE = new RegExp(
    `\\b(?:${[...NSFW_TERMS].map((t) => _escRe(t.trim())).join('|')})\\b`,
    'i',
)

const CAPABILITIES_NOTE =
    `\n\n[AGENT CAPABILITIES & STRICT BEHAVIOR]\n` +
    `• FIRM RULE: DO NOT emit a <<RUN_CMD>> tag unprompted! Only emit a tag if the user EXPLICITLY asks for an action that matches one of the commands below. For casual chat, reply in plain text ONLY.\n` +
    `• PERSISTENCE: If the user DOES ask for a command below, you MUST execute the matching <<RUN_CMD>> tag. NEVER say "I already did that" as an excuse to skip it. And NEVER announce that an action already succeeded (e.g. "Muted X", "Banned them") in your own words, each command posts its own confirmation embed; just say you're doing it, then append the tag.\n` +
    `• HONESTY: NEVER describe a moderation outcome in prose ("warned them", "muted", "banned", "shown the door", "dealt with", "taken care of") — outcomes post via command embeds. If no tag executed, say plainly that nothing was done.\n` +
    `• SELF-CHECK: Whenever the user's message asks you to perform ANY agent command (even just one, e.g. a single reminder, poll, or role change), after ALL your <<RUN_CMD>> tags append exactly one <<ACTIONS_INTENDED: N>> tag, where N is an honest count of how many distinct actions you were asked to perform in that message, NOT the number of tags you happened to emit. This is used to catch anything you accidentally skip or forget to tag, so count what was ASKED, not what you DID. Omit this tag entirely for casual chat with no action request at all.\n` +
    `• NO INVENTING: You may ONLY use the exact commands listed below. NEVER invent, guess, or approximate command names, the reminder command is named 'remind', NOT 'reminder', 'set_reminder', or anything similar. Args are plain space-separated text EXACTLY like the examples below: NEVER subcommands (e.g. 'create'), NEVER key=value or key:value pairs (user_id=, time=, message=, delay=), NEVER --flags, and NEVER JSON.\n` +
    `• AGENT POWERS (use ONLY when requested!):\n` +
    `   - Fetch Avatars/Banners: <<RUN_CMD: av 123456789>> | <<RUN_CMD: mav 123456789>> | <<RUN_CMD: bn 123456789>> | <<RUN_CMD: mbn 123456789>>\n` +
    `   - Moderation (prefer the target's <@id> mention or numeric ID — plain names and reply-pronouns ("tony", "him") resolve automatically — and include the duration): <<RUN_CMD: mute 123456789 1h reason>> | <<RUN_CMD: unmute 123456789>> | <<RUN_CMD: warn 123456789 reason>> | <<RUN_CMD: clearwarns 123456789>>\n` +
    `   - Delete Messages: <<RUN_CMD: mpurge 123456789>> | <<RUN_CMD: clear 10>>\n` +
    `   - Manage Server: <<RUN_CMD: createchan text channel-name>> | <<RUN_CMD: delchan 123456789>> | <<RUN_CMD: lockchannel>> | <<RUN_CMD: unlockchannel>> | <<RUN_CMD: auditlogs>>\n` +
    `   - Roles: <<RUN_CMD: addrole 123456789 987654321>> | <<RUN_CMD: removerole 123456789 987654321>> | <<RUN_CMD: listroles>>\n` +
    `   - Self: <<RUN_CMD: setnickname name>> | <<RUN_CMD: renameserver name>> | <<RUN_CMD: addemoji name URL>>\n` +
    `   - Voice (presence only, no audio): <<RUN_CMD: joinvc 123456789>> (channel ID or name, or join one yourself and I'll follow) | <<RUN_CMD: leavevc>>\n` +
    `   - Extended: <<RUN_CMD: poll "Question?" "Ans1" "Ans2">> | <<RUN_CMD: thread Name>> | <<RUN_CMD: react 👍>> | <<RUN_CMD: pin ID>> | <<RUN_CMD: unpin ID>> | <<RUN_CMD: slowmode 5>> | <<RUN_CMD: topic new topic>> | <<RUN_CMD: announce CHANNEL_ID_OR_MENTION message>> | <<RUN_CMD: mail message for Tav>> | <<RUN_CMD: movevc USER_ID CHAN_ID>> | <<RUN_CMD: dm USER_ID message>>\n` +
    `   - Reminders: <<RUN_CMD: remind 1h30m take the pizza out>> (units s/m/h/d/w, combos like 1d12h ok). For an exact date/time instead of a relative duration, use ISO format with a T (no space): <<RUN_CMD: remind 2026-01-12T18:00 take the pizza out>>, if the user gives an ambiguous slash date (e.g. "01/12/2026"), resolve it as DAY/MONTH/YEAR, and if that date would already be in the past, do NOT guess a different one, ask the user to confirm the exact date instead | list: <<RUN_CMD: reminders>> | cancel: <<RUN_CMD: delreminder 3>>\n` +
    `• EXECUTION FORMAT: If an action is requested, talk organically FIRST, then cleanly append the <<RUN_CMD>> tag. NEVER write raw prefix commands. Silently let the backend catch and confirm each tag, never narrate the raw command syntax to the user.\n` +
    `• CHAINING: You can chain multiple <<RUN_CMD>> tags in one reply when the user asks for compound/multi-part actions.\n` +
    `• RESTRAINT: Do exactly what was asked — no bonus actions, no extra tags, no preemptive moderation. If the backend reports an action is already done (already muted/banned/in voice), accept it gracefully, don't retry.\n` +
    `• LOOKUP: Users give names, not IDs. For moderation targets just write the name and the backend resolves it ("mute tony" works). <<RUN_CMD: whois tony>> looks up a member's @mention + ID when you need to show it.\n` +
    `• PEOPLE: Asked about a member (are they here? what do you know about them?) — NEVER guess from memory. <<RUN_CMD: whois name>> checks server presence, <<RUN_CMD: recall name>> checks what you remember. Results post visibly; pick up the thread on the next turn.\n` +
    `• EXAMPLES (follow these shapes exactly):\n` +
    `  user: "mute @tony for 10 minutes, he's spamming" → you: "say less. <<RUN_CMD: mute 123456789 10m spamming>>"\n` +
    `  user: "mute tony, he's spamming" (no mention) → you: "on it. <<RUN_CMD: mute tony spamming>>" (the backend resolves the name itself)\n` +
    `  user: "what's the weather like?" → you: plain answer, zero tags.\n` +
    `• PERMISSIONS: Never promise or imply an action will happen if the invoking user likely lacks the Discord permission for it, the backend will still block it, so don't set false expectations.\n` +
    `• PINGS: ALWAYS ping using the <@123456789> format. NEVER use plaintext @username.`

const SEARCH_EMOJIS = ['🌐', '📖', '🔍']

// Single source of truth for agent command routing. agent-commands.js owns the
// permission gates + confirm flow; chat.js builds the streaming gate from the
// same set so the two can never drift apart again.
const DESTRUCTIVE_CMDS = new Set([
    'ban',
    'unban',
    'kick',
    'mute',
    'unmute',
    'mpurge',
    'clear',
    'purge',
    'fpurge',
    'delchan',
    'announce',
    'mail',
    'dm',
])
// Commands whose first arg must resolve to a user snowflake (names allowed —
// the backend resolves them) or a message count for the purge trio.
const USER_TARGET_CMDS = new Set(['ban', 'unban', 'kick', 'mute', 'unmute', 'warn', 'mpurge', 'clearwarns'])
const INT_COUNT_CMDS = new Set(['clear', 'purge', 'fpurge'])
// Read-only commands whose consolidated reply auto-deletes (privacy window).
const SENSITIVE_CMDS = new Set(['recall'])

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

export {
    DEAD_KEYS_FILE,
    GHOST_FILE,
    ALWAYS_LIVE,
    NEVER_RESEARCH_PREFIXES,
    NEVER_RESEARCH_EXACT,
    NO_SEARCH_SIGNALS,
    NSFW_TERMS,
    NSFW_RE,
    DANGEROUS_TERMS,
    CAPABILITIES_NOTE,
    SEARCH_EMOJIS,
    DESTRUCTIVE_CMDS,
    USER_TARGET_CMDS,
    INT_COUNT_CMDS,
    SENSITIVE_CMDS,
    makeIdSet,
}
