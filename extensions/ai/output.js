// Output layer: degenerate-response detection, INTERNAL-context leak guard,
// message splitting, safe replies, and expressive media (stickers/GIFs).
import { MessageFlags } from 'discord.js'
import { NSFW_TERMS } from './constants.js'
import { AgentCommandCore } from './agent-commands.js'
import { containsDisallowedHate, inPersonaRefusal, safetyRefusal } from './safety.js'
import { logAction } from '../moderation.js'

export class OutputCore extends AgentCommandCore {
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
    finalSecurityCheck(text, context = null) {
        if (text === undefined || text === null) return ''
        if (containsDisallowedHate(text)) {
            const user = context?.author ?? context?.user
            const guild = context?.guild
            if (user?.id && guild?.id && this.db) {
                this._safetyAuditAt ??= new Map()
                const key = `${guild.id}:${user.id}`
                const now = Date.now()
                if (now - (this._safetyAuditAt.get(key) ?? 0) > 60_000) {
                    this._safetyAuditAt.set(key, now)
                    logAction(this.db, guild.id, user.id, this.client.user.id, 'AI safety block', 'Unsafe generated output')
                }
            }
            text = safetyRefusal(text)
        }
        text = inPersonaRefusal(text)
        // Strip unrenderable/control/private-use codepoints the model occasionally
        // emits (shows up as □ boxes in Discord) before any other cleanup.
        let text2 = text.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\uE000-\uF8FF\uFFF0-\uFFFF]/g, '')
        let out = text2.replace(/@(?:[\u200B\u200C\u200D\uFEFF]*)?(everyone|here)/gi, '🪼')
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
        const validated = this.finalSecurityCheck(String(content || ''), message)
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
            const giphyKey = this._config?.giphyKey
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
}
