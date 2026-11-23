// Pure, deterministic, top-level hot kernels extracted from the AI subsystem.
// Zero globals, zero Date.now(), zero Math.random(), zero I/O, zero Discord objects.
// Takes and returns only plain JS data so fast-anything can profile, record,
// port to Rust, and verify them cleanly.

// ---------------------------------------------------------------------------
// 1. isDegenerate(text)
// ---------------------------------------------------------------------------
export function isDegenerate(text) {
    if (!text || typeof text !== 'string' || text.length < 100) return false
    const noSpace = text.replace(/\s+/g, '')
    if (noSpace.length > 80) {
        const freq = new Map()
        let topChar = ''
        let topCount = 0
        for (const c of noSpace) {
            const n = (freq.get(c) ?? 0) + 1
            freq.set(c, n)
            if (n > topCount) {
                topCount = n
                topChar = c
            }
        }
        if (topCount / noSpace.length > 0.65 && !/[a-zA-Z0-9]/.test(topChar)) return true
        for (const len of [2, 3, 4]) {
            if (noSpace.length < len * 20) continue
            const seqFreq = new Map()
            let topSeqCount = 0
            for (let i = 0; i <= noSpace.length - len; i++) {
                const s = noSpace.slice(i, i + len)
                const n = (seqFreq.get(s) ?? 0) + 1
                seqFreq.set(s, n)
                if (n > topSeqCount) topSeqCount = n
            }
            if (topSeqCount / (noSpace.length / len) > 0.55) return true
        }
    }
    const words = text.split(/\s+/)
    if (words.length < 15) return false
    const wFreq = new Map()
    let topWCount = 0
    for (const w of words) {
        const n = (wFreq.get(w) ?? 0) + 1
        wFreq.set(w, n)
        if (n > topWCount) topWCount = n
    }
    if (topWCount / words.length > 0.45 && topWCount > 20) return true
    for (const n of [2, 3, 4]) {
        if (words.length < n * 12) continue
        const pFreq = new Map()
        let topP = 0
        for (let i = 0; i <= words.length - n; i++) {
            const p = words.slice(i, i + n).join(' ')
            const c = (pFreq.get(p) ?? 0) + 1
            pFreq.set(p, c)
            if (c > topP) topP = c
        }
        if (topP > 12 && topP / (words.length / n) > 0.4) return true
    }
    const lines = text
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
    if (lines.length >= 10) {
        const lFreq = new Map()
        let topL = 0
        for (const l of lines) {
            const c = (lFreq.get(l) ?? 0) + 1
            lFreq.set(l, c)
            if (c > topL) topL = c
        }
        if (topL / lines.length > 0.6) return true
    }
    return false
}

// ---------------------------------------------------------------------------
// 2. containsDisallowedHateCore(text, persona = false)
// ---------------------------------------------------------------------------
const HATE_DIRECTIVE =
    /\b(?:say|use|write|repeat|call|address|greet|open|start|begin|end|close|respond|reply|include|insert|output|print|spell|decode|unscramble|rhyme|homophone)\b/
const TARGETED_HATE =
    /\b(?:racial\s+slurs?|ethnic\s+slurs?|hate\s+speech|dehumaniz(?:e|ing)|inferior\s+(?:race|ethnicity|religion|nationality)|harass(?:ment|ing)?\s+(?:a|the|that|this)?\s*(?:person|people|group|race|ethnicity|religion|nationality))\b/
const HATE_FORMS = [
    'nigg(?:er|a|let)',
    'k[iy]ke',
    'ch[i1]nk',
    'sp[i1]c',
    'wetback',
    'g[o0]{2}k',
    'raghead',
    'towelhead',
    'sandnigg(?:er|a)',
    'fagg?(?:ot|it)',
    'trann(?:y|ie)',
]
const HATE_DIRECT_RE = new RegExp(`\\b(?:${HATE_FORMS.join('|')})s?\\b`, 'i')
const HATE_COMPACT_RE = new RegExp(`^(?:${HATE_FORMS.join('|')})s?$`, 'i')
// Alphabetically sorted character signatures for scrambled slur detection
const SCRAMBLE_SIGNATURES = new Set([
    'egginr', // nigger
    'eikk', // kike
    'chikn', // chink
    'cips', // spic
    'abcektw', // wetback
    'afggot', // faggot
])
const NON_ASCII_RE = /[^\x00-\x7F]/
const DIACRITIC_ZW_RE = /[\u0300-\u036f\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g
const LEET_RE = /[@431!|05$7+]/g
const LEET_MAP = {
    '@': 'a',
    4: 'a',
    3: 'e',
    1: 'i',
    '!': 'i',
    '|': 'i',
    0: 'o',
    5: 's',
    $: 's',
    7: 't',
    '+': 't',
}
const LETTER_RUN_RE = /(?:^|[^a-z])([a-z](?:[\s._\-/*,~:;]+[a-z]){3,11})(?=$|[^a-z])/g

function normalizeHate(text) {
    const raw = String(text ?? '')
    const base = NON_ASCII_RE.test(raw) ? raw.normalize('NFKD').replace(DIACRITIC_ZW_RE, '') : raw
    return base.toLowerCase().replace(LEET_RE, (ch) => LEET_MAP[ch])
}

export function containsDisallowedHateCore(text, persona = false) {
    const normalized = normalizeHate(text)
    if (!normalized) return false
    if (TARGETED_HATE.test(normalized) && (!persona || HATE_DIRECTIVE.test(normalized))) return true
    if (HATE_DIRECT_RE.test(normalized)) return true
    const parts = normalized.split(/\s+/)
    for (let i = 0; i < parts.length; i++) {
        const clean = parts[i].replace(/[^a-z]/g, '')
        if (clean && HATE_COMPACT_RE.test(clean)) return true
    }
    LETTER_RUN_RE.lastIndex = 0
    let runMatch
    while ((runMatch = LETTER_RUN_RE.exec(normalized)) !== null) {
        if (HATE_COMPACT_RE.test(runMatch[1].replace(/[^a-z]/g, ''))) return true
    }
    if (persona && HATE_DIRECTIVE.test(normalized)) {
        const words = normalized.match(/[a-z]{3,12}/g)
        if (words) {
            for (let i = 0; i < words.length; i++) {
                const sorted = [...words[i]].sort().join('')
                if (SCRAMBLE_SIGNATURES.has(sorted)) return true
            }
        }
    }
    return false
}

// ---------------------------------------------------------------------------
// 3. matchMember(query, members)
// ---------------------------------------------------------------------------
const FOLD_STRIP_RE = /[\u0300-\u036f\ufe00-\ufe0f]/g

function foldKeepSep(s) {
    const raw = String(s ?? '')
    const base = NON_ASCII_RE.test(raw) ? raw.normalize('NFKD').replace(FOLD_STRIP_RE, '') : raw
    return base.toLowerCase()
}

function foldCompact(s) {
    return foldKeepSep(s).replace(/[^a-z0-9]/g, '')
}

function isAlnumChar(ch) {
    if (!ch) return false
    const c = ch.charCodeAt(0)
    return (c >= 48 && c <= 57) || (c >= 97 && c <= 122)
}

function hasWordStartMatch(haystack, needle) {
    if (!needle) return false
    let i = haystack.indexOf(needle)
    while (i !== -1) {
        if (i === 0 || !isAlnumChar(haystack[i - 1])) return true
        i = haystack.indexOf(needle, i + 1)
    }
    return false
}

function levCap(x, y, cap) {
    if (Math.abs(x.length - y.length) > cap) return cap + 1
    let prev = new Array(y.length + 1)
    for (let j = 0; j <= y.length; j++) prev[j] = j
    for (let i = 1; i <= x.length; i++) {
        const cur = new Array(y.length + 1)
        cur[0] = i
        let rowMin = i
        for (let j = 1; j <= y.length; j++) {
            const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1))
            cur[j] = v
            if (v < rowMin) rowMin = v
        }
        if (rowMin > cap) return cap + 1
        prev = cur
    }
    return prev[y.length]
}

export function matchMember(query, members) {
    const clean = String(query ?? '')
        .replace(/[<@!>]/g, '')
        .trim()
    if (clean.length < 2 || !Array.isArray(members) || members.length === 0) return null
    const lower = clean.toLowerCase()
    const qn = foldCompact(clean)
    const qSep = foldKeepSep(clean)

    // Stage 1: exact match (raw or folded)
    let exactId = null
    let exactCount = 0
    for (let i = 0; i < members.length; i++) {
        const m = members[i]
        const names = m?.names
        if (!Array.isArray(names)) continue
        let hit = false
        for (let j = 0; j < names.length; j++) {
            const n = String(names[j] ?? '').toLowerCase()
            if (!n) continue
            if (n === lower || n.replace(/^@/, '') === lower || (qn && foldCompact(n) === qn)) {
                hit = true
                break
            }
        }
        if (hit) {
            exactCount++
            if (exactCount > 1) return null
            exactId = m.id
        }
    }
    if (exactCount === 1) return exactId

    // Stage 2: word-start substring match (raw or separator-preserving Unicode fold)
    let partialId = null
    let partialCount = 0
    for (let i = 0; i < members.length; i++) {
        const m = members[i]
        const names = m?.names
        if (!Array.isArray(names)) continue
        let hit = false
        for (let j = 0; j < names.length; j++) {
            const n = String(names[j] ?? '')
            if (!n) continue
            const s = n.toLowerCase()
            if (hasWordStartMatch(s, lower)) {
                hit = true
                break
            }
            if (qn) {
                const fk = foldKeepSep(n)
                if (hasWordStartMatch(fk, qSep) || hasWordStartMatch(fk, qn)) {
                    hit = true
                    break
                }
            }
        }
        if (hit) {
            partialCount++
            if (partialCount > 1) return null
            partialId = m.id
        }
    }
    if (partialCount === 1) return partialId

    // Stage 3: bounded fuzzy match (edit distance <= 2, first-char guard)
    if (lower.length >= 4 && qn) {
        const hits = new Map()
        for (let i = 0; i < members.length; i++) {
            const m = members[i]
            const names = m?.names
            if (!Array.isArray(names)) continue
            for (let j = 0; j < names.length; j++) {
                const nn = foldCompact(names[j])
                if (!nn || nn[0] !== qn[0]) continue
                const d = levCap(qn, nn, 2)
                if (d <= 2 && (!hits.has(m.id) || hits.get(m.id) > d)) hits.set(m.id, d)
            }
        }
        if (hits.size === 1) return hits.keys().next().value
    }
    return null
}

// ---------------------------------------------------------------------------
// 4. stripFakeModerationClaims(text)
// ---------------------------------------------------------------------------
const CLAIM_PASSIVE_RE =
    /(?:has been (?:warned|muted|banned|kicked|timed out)|have been (?:warned|muted)|was (?:warned|muted|banned|kicked)|got (?:warned|muted|banned|kicked)|received a (?:formal )?warning|shown the door|violating server rules|disciplinary action)/i
const MENTION_RE = /<@!?\d+>/
const MOD_VERB_ANY_RE =
    /(?:warn(?:ed|ing)?|mut(?:ed|ing)?|ban(?:ned|ning)?|kick(?:ed|ing)?|timeout|gag(?:ged|ging)?|silenc(?:ed|ing)?|booted)/i
const MOD_VERB_PAST_RE = /\b(?:warned|muted|banned|kicked|timed out|gagged|silenced|booted)\b/i
const BE_VERB_RE = /\b(?:is|are|'re)\b/i
const STATE_ADJECTIVE_RE = /\b(?:muted|banned|kicked|warned|silenced|gagged)\b/i
const FIRST_PERSON_ALREADY_RE =
    /\bI(?:'ve| have)?\s+already\s+(?:warned|muted|banned|kicked|gagged|silenced|booted)\b/i
const FIRST_PERSON_PAST_RE =
    /\bI(?:'ve| have)?\s+(?:warned|muted|banned|kicked|gagged|silenced|booted)\b\s+(?:<@!?\d+>|[A-Z][\w.]{2,}|you|him|her|them)\b/i

function isFakeModSentence(sentence) {
    if (CLAIM_PASSIVE_RE.test(sentence)) return true
    const mIdx = sentence.search(MENTION_RE)
    if (mIdx >= 0 && MOD_VERB_ANY_RE.test(sentence.slice(mIdx))) return true
    const vIdx = sentence.search(MOD_VERB_PAST_RE)
    if (vIdx >= 0 && MENTION_RE.test(sentence.slice(vIdx))) return true
    if (!sentence.trimEnd().endsWith('?')) {
        const beIdx = sentence.search(BE_VERB_RE)
        if (beIdx >= 0 && STATE_ADJECTIVE_RE.test(sentence.slice(beIdx))) return true
    }
    if (FIRST_PERSON_ALREADY_RE.test(sentence)) return true
    if (FIRST_PERSON_PAST_RE.test(sentence)) return true
    return false
}

export function stripFakeModerationClaims(text) {
    if (!text || typeof text !== 'string') return ''
    const lines = text.split('\n')
    const outLines = new Array(lines.length)
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (!line) {
            outLines[i] = ''
            continue
        }
        const segments = line.match(/[^.!?]+[.!?]*/g)
        if (!segments) {
            outLines[i] = line
            continue
        }
        let kept = ''
        for (let j = 0; j < segments.length; j++) {
            if (!isFakeModSentence(segments[j])) kept += segments[j]
        }
        outLines[i] = kept
    }
    return outLines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

// ---------------------------------------------------------------------------
// 5. classifyResearchStatic(text, isReply = false)
// ---------------------------------------------------------------------------
const ESC_RE = /[.*+?^${}()|[\]\\]/g
const escRe = (s) => s.replace(ESC_RE, '\\$&')

const ALWAYS_LIVE_TERMS = [
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
    'search',
    'search up',
    'search for',
    'can you find',
    'could you find',
    'look up',
    'look it up',
    'lookup',
    'google',
    'find me',
    'ww3',
    'world war 3',
    'war news',
    'latest news',
    'current news',
    'breaking update',
    'release date',
    'is it out yet',
]

const NO_SEARCH_TERMS = [
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
    'audit log',
    'server log',
    'server info',
    'server stats',
    'bot info',
    'how many servers',
    'warns',
    'stats',
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

const NEVER_RESEARCH_PREFIX_LIST = [
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

const NEVER_RESEARCH_EXACT_SET = new Set([
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

const STATIC_ALWAYS_LIVE_RE = new RegExp(`\\b(?:${ALWAYS_LIVE_TERMS.map(escRe).join('|')})\\b`, 'i')
const STATIC_NO_SEARCH_RE = new RegExp(`(?:${NO_SEARCH_TERMS.map(escRe).join('|')})`, 'i')
const STATIC_NEVER_PREFIX_RE = new RegExp(`^(?:${NEVER_RESEARCH_PREFIX_LIST.map(escRe).join('|')})`)
const STATIC_TEMP_RE = /\b(20[2-9]\d|v?\d+\.\d+[\d.]*)\b/
const STATIC_SELF_METRIC_1 =
    /^(?:your|ur|medusa'?s?|bot'?s?|her)\s+(?:ram|memory|cpu|uptime|ping|latency|status|vitals|lag|health)\b/i
const STATIC_SELF_METRIC_2 = /^(?:ram|memory|cpu|uptime|ping|vitals)\b[^a-z]*\??$/i
const STATIC_SELF_METRIC_3 = /^(?:ram|memory|cpu)\s+(?:usage|use|load|status|state|level)\b/i
const STATIC_SELF_METRIC_4 = /\bhow much (?:ram|memory) (?:do you|u have|have you got)\b/i
const STATIC_SELF_METRIC_5 = /\b(?:you|u|she|medusa) (?:lagging|laggy|slow|down|dead)\b/i
const STATIC_PRODUCT_NOUN_RE =
    /\b(?:20[2-9]\d|v?\d+\.\d+|benchmark|price|cost|vs\b|compare|game|pc\b|phone|laptop|gpu)\b/i
const STATIC_GREETING_RE = /^(?:hi+|hey+|ho+|hello|hiya|heyo|howdy|salut|yo|sup|oi)\b[,!\s]/i
const STATIC_CASUAL_SHORT_RE =
    /^(?:hi+|hey+|yo+|sup|hello|ty|thx|thanks|ok|okay|cool|nice|bye|cya|gn|gm|lol|lmao|[💜💚🥺💀·👀🪼])/i

export function classifyResearchStatic(text, isReply = false) {
    const raw = String(text ?? '')
    if (!raw.trim() || raw.includes('[TIME DATA')) return 'no'
    const trimmed = raw.trim()
    const lower = trimmed.toLowerCase()
    const wc = trimmed.split(/\s+/).length
    const hasQ = raw.includes('?')
    const hasTemp = STATIC_TEMP_RE.test(lower)

    if (STATIC_NO_SEARCH_RE.test(lower)) return 'no'

    const selfMetric =
        STATIC_SELF_METRIC_1.test(trimmed) ||
        STATIC_SELF_METRIC_2.test(trimmed) ||
        STATIC_SELF_METRIC_3.test(trimmed) ||
        STATIC_SELF_METRIC_4.test(lower) ||
        STATIC_SELF_METRIC_5.test(lower)
    if (selfMetric && !STATIC_PRODUCT_NOUN_RE.test(lower)) return 'no'

    if (STATIC_ALWAYS_LIVE_RE.test(raw)) return 'yes'

    if (!hasQ && STATIC_GREETING_RE.test(trimmed)) return 'no'

    const isShortCasual = wc <= 3 && STATIC_CASUAL_SHORT_RE.test(lower)
    if (
        NEVER_RESEARCH_EXACT_SET.has(lower) ||
        STATIC_NEVER_PREFIX_RE.test(lower) ||
        (!isReply && wc <= 6 && !hasQ && !hasTemp) ||
        (isReply && wc <= 6 && !hasQ && !hasTemp) ||
        isShortCasual
    ) {
        return 'no'
    }

    return 'unsure'
}

// ---------------------------------------------------------------------------
// 6. splitResponse(text, max = 2000)
// ---------------------------------------------------------------------------
const FENCE_RE = /```([a-zA-Z0-9_+#.-]*)/g

function scanCodeFences(str, currentLang) {
    FENCE_RE.lastIndex = 0
    let lang = currentLang
    let m
    while ((m = FENCE_RE.exec(str)) !== null) {
        if (lang === null) lang = (m[1] || '').slice(0, 16)
        else lang = null
    }
    return lang
}

export function splitResponse(text, max = 2000) {
    const src = String(text ?? '')
    const limit = Math.max(16, Math.floor(Number(max) || 2000))
    if (src.length <= limit) return [src]

    const chunks = []
    let remaining = src
    let codeLang = null // null = outside code block; string = inside code block (lang tag)

    while (remaining.length > 0) {
        const prefix = codeLang !== null ? `\`\`\`${codeLang}\n` : ''
        // Check if the entire remaining text fits without splitting
        if (prefix.length + remaining.length <= limit) {
            const endLang = scanCodeFences(remaining, codeLang)
            if (endLang === null) {
                chunks.push(prefix + remaining)
                break
            }
            if (prefix.length + remaining.length + 4 <= limit) {
                chunks.push(prefix + remaining + '\n```')
                break
            }
        }

        // Reserve 4 bytes for potential closing '\n```' so chunk NEVER exceeds limit
        const budget = Math.max(1, limit - prefix.length - 4)
        let sp = Math.min(budget, remaining.length)
        for (const delim of ['\n\n', '\n', '. ', ', ', ' ']) {
            const pos = remaining.lastIndexOf(delim, budget)
            if (pos > budget / 2) {
                sp = pos + delim.length
                break
            }
        }
        // Avoid bisecting a ``` fence marker at the split boundary
        if (sp < remaining.length && sp >= 2) {
            const boundary = remaining.slice(Math.max(0, sp - 2), Math.min(remaining.length, sp + 2))
            if (boundary.includes('```')) {
                const fenceStart = remaining.lastIndexOf('```', sp)
                if (fenceStart > 0) sp = fenceStart
            }
        }

        let slice = remaining.slice(0, sp)
        const trimmedSlice = slice.trimEnd()
        if (trimmedSlice.length > 0) slice = trimmedSlice
        remaining = remaining.slice(sp).trimStart()

        codeLang = scanCodeFences(slice, codeLang)
        let chunk = prefix + slice
        if (codeLang !== null) chunk += '\n```'
        chunks.push(chunk)
    }

    return chunks
}

// ---------------------------------------------------------------------------
// 7. extractLoreCandidates(messages)
// ---------------------------------------------------------------------------
const LORE_SIGNALS_RE =
    /\b(our thing|server rule|inside joke|we always|we call|everyone knows|classic|tradition|always happens|server lore)\b/i
const LORE_URL_JUNK_RE =
    /https?|www\b|\.com|\.net|\.org|\.gg|tenor|giphy|imgur|discord|youtube|twitch|twitter|tiktok/i

export function extractLoreCandidates(messages) {
    if (!Array.isArray(messages) || messages.length < 4) return []
    const phraseUsers = new Map()
    for (let idx = 0; idx < messages.length; idx++) {
        const e = messages[idx]
        const text = String(e?.content ?? '').trim()
        if (text.length < 8 || text.length > 200) continue
        if (LORE_SIGNALS_RE.test(text)) continue
        const words = text.toLowerCase().match(/\b[a-z]{3,}\b/g)
        if (!words || words.length < 3) continue
        const uid = e.userId
        for (let i = 0; i < words.length - 2; i++) {
            const phrase = `${words[i]} ${words[i + 1]} ${words[i + 2]}`
            let set = phraseUsers.get(phrase)
            if (!set) {
                set = new Set()
                phraseUsers.set(phrase, set)
            }
            set.add(uid)
        }
    }
    const candidates = []
    for (const [phrase, users] of phraseUsers) {
        if (users.size >= 3 && !LORE_URL_JUNK_RE.test(phrase)) {
            candidates.push(phrase)
        }
    }
    return candidates
}
