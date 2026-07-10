// Research layer: serper/tavily tool loop, source parsing, and the
// three-stage needsResearch router (signal lists -> cheap classifier).
import { LRUCache } from 'lru-cache'
import {
    ALWAYS_LIVE,
    DANGEROUS_TERMS,
    NEVER_RESEARCH_EXACT,
    NEVER_RESEARCH_PREFIXES,
    NO_SEARCH_SIGNALS,
    NSFW_TERMS,
} from './constants.js'
import { ProviderCore } from './providers.js'

export class ResearchCore extends ProviderCore {
    // Research pipeline
    // Detect Groq's 400 tool_use_failed ("Failed to call a function") so we can retry without tools.
    _isToolCallError(err) {
        if (err?.status !== 400 && err?.statusCode !== 400) return false
        const s = `${err?.code ?? ''} ${err?.message ?? ''} ${err?.error?.message ?? ''}`.toLowerCase()
        return (
            s.includes('tool_use_failed') ||
            s.includes('tool choice is none') ||
            s.includes('model called a tool') ||
            s.includes('failed_generation') ||
            s.includes('failed to call a function') ||
            (s.includes('function') && s.includes('adjust your prompt'))
        )
    }

    async _callResearch(prompt) {
        if (!this._researchClient) return null

        const serperKey = (this._config ?? this.config).search?.serperKey
        const tavilyKey = (this._config ?? this.config).search?.tavilyKey
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
                    if (!(hasSearch && this._isToolCallError(err))) throw err
                    // Groq 400 tool_use_failed: the model emitted a malformed tool call. Retry
                    // WITH tools first — stripping them mid-round makes gpt-oss emit phantom
                    // calls that 400 as "Tool choice is none, but model called a tool". Only
                    // fall back to a tool-less round if the with-tools retry fails too.
                    try {
                        r = await runRound(true)
                    } catch {
                        r = await runRound(false)
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
                this._groqCall(messages, this.classifierModel, 5, 0, undefined, this._classifierClient),
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
}
