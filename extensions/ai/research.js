// Research layer: serper/tavily tool loop, source parsing, and the
// three-stage needsResearch router (signal lists -> cheap classifier).
import { LRUCache } from 'lru-cache'
import {
    ALWAYS_LIVE,
    DANGEROUS_TERMS,
    NEVER_RESEARCH_EXACT,
    NEVER_RESEARCH_PREFIXES,
    NO_SEARCH_SIGNALS,
    NSFW_RE,
} from './constants.js'
import { ProviderCore } from './providers.js'

export class ResearchCore extends ProviderCore {
    // Mirrors the reasoning-model detection in ProviderCore._buildPayload: these
    // models need an explicit low effort or they chew seconds of chain-of-thought
    // on every tool round.
    _isLowEffortReasoning(model) {
        return /\bo[13]\b|deepseek-r|gpt-oss/i.test(model ?? '')
    }
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

    // Entry point: primary research client first, then this agent's own
    // fallback chain (each entry carries its own provider), then knowledge
    // fallback. Every caller (stateless, ResearchResponse, second-thought)
    // gets the full chain from this one method.
    async _callResearch(prompt) {
        if (this._researchClient) {
            const out = await this._callResearchWith(this._researchClient, this.researchModel, prompt, true)
            if (out) return out
        }
        for (const fb of this.agentFallbacks?.research ?? []) {
            try {
                const client = this._fallbackClient(fb)
                if (!client) continue
                const out = await this._callResearchWith(client, fb.model, prompt, false)
                if (out) {
                    console.log(`[AI] Research fallback answered via ${fb.provider ?? fb.baseUrl} / ${fb.model}`)
                    return out
                }
            } catch {}
        }
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

    // One full tool-loop run against a specific client+model. Key rotation
    // only happens for the primary (allowRotate); fallbacks just move on.
    async _callResearchWith(client, model, prompt, allowRotate, _retried = false) {
        if (!client) return null

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
                    'You are a precise research assistant. Use the web_search tool to find current information when needed. Synthesize results factually. End with: SOURCES: [Name](url), max 3 real URLs. Omit if none.',
            },
            { role: 'user', content: prompt.slice(0, 800) },
        ]

        const hasSearch = !!(serperKey || tavilyKey)
        try {
            // Bounded tool-calling loop. Tools stay attached on every round so tool_choice is
            // never implicitly "none" while the model might still emit a call, that mismatch is
            // exactly what triggers the provider's 400 tool_use_failed (Tool choice is none, but
            // model called a tool). The round cap prevents runaway search loops.
            const MAX_ROUNDS = 4
            const convo = [...messages]
            for (let round = 0; round < MAX_ROUNDS; round++) {
                // Lower temp on tool rounds, high temp is the main cause of malformed tool-call JSON.
                const toolRoundTemp = Math.min(this.researchTemp, 0.3)
                const runRound = (useTools) =>
                    client.chat.completions.create({
                        model,
                        messages: convo,
                        tools: useTools ? [searchTool] : undefined,
                        tool_choice: useTools ? 'auto' : undefined,
                        max_completion_tokens: this.searchTokens,
                        temperature: useTools ? toolRoundTemp : this.researchTemp,
                        top_p: this.topP,
                        // Reasoning models (notably gpt-oss) think hard by default;
                        // low effort keeps the 4-round tool loop snappy.
                        ...(this._isLowEffortReasoning(model) ? { reasoning_effort: 'low' } : {}),
                    })
                let r
                try {
                    r = await runRound(hasSearch)
                } catch (err) {
                    if (!(hasSearch && this._isToolCallError(err))) throw err
                    // Groq 400 tool_use_failed: the model emitted a malformed tool call. Retry
                    // WITH tools first, stripping them mid-round makes gpt-oss emit phantom
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
                                // No search provider configured, tell the model to answer from knowledge
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

            // Round cap reached without a plain-text answer, force one final synthesis pass.
            const fin = await client.chat.completions.create({
                model,
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
                ...(this._isLowEffortReasoning(model) ? { reasoning_effort: 'low' } : {}),
            })
            return fin.choices?.[0]?.message?.content ?? null
        } catch (e) {
            console.error('[AI] _callResearch failed:', String(e).slice(0, 300))
            // 429 with spare research keys: rotate and give the whole loop one more shot.
            // Primary only — fallbacks walk to the next entry instead.
            if (allowRotate && !_retried && this._isKeyError(e) && this.researchKeys.length > 1) {
                this.currentResearchKeyIdx = (this.currentResearchKeyIdx + 1) % this.researchKeys.length
                this._initGroq()
                console.log(`[AI] Research key rotated: -> ${this.currentResearchKeyIdx + 1}`)
                return this._callResearchWith(this._researchClient, this.researchModel, prompt, allowRotate, true)
            }
            return null
        }
    }

    _parseSources(raw) {
        const match = raw.match(/\n*SOURCES?:\s*(.+?)$/is)
        if (!match) return { text: raw.trim(), sources: [] }
        const text = raw.slice(0, match.index).trim()
        const sources = [...match[1].matchAll(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g)]
            .slice(0, 3)
            .map((m) => ({ name: m[1].trim(), url: m[2].trim() }))
        // The model sometimes cites bare URLs instead of markdown links — harvest
        // those from the SOURCES block so research answers don't silently lose
        // their footer. Only inside the block: never launder passing mentions
        // from the prose into fake citations.
        if (!sources.length) {
            const seen = new Set()
            for (const m of match[1].matchAll(/https?:\/\/[^\s)>\]]+/g)) {
                const url = m[0].slice(0, 300)
                if (seen.has(url)) continue
                seen.add(url)
                let name = 'link'
                try {
                    name = new URL(url).hostname.replace(/^www\./, '')
                } catch {}
                sources.push({ name, url })
                if (sources.length >= 3) break
            }
        }
        return { text, sources }
    }

    _extractSearchQuery(prompt) {
        let q = prompt.trim()
        // Strip leading greetings and filler words
        q = q.replace(/^(?:hi+|hey+|yo+|sup|hello|oi|ok|okay)[,!\s]+/i, '').trim()
        // Strip trailing "…and research" / "…research for me" so the query stays clean
        q = q.replace(/\s+(?:and\s+)?research(?:\s+for\s+me|\s+it\s+up|\s+this\s+up|\s+that\s+up)?\.?$/i, '').trim()
        const you = '(?:you|u|ya)'
        const prefixes = [
            new RegExp(
                `^(?:do|perform|conduct)\\s+(?:a\\s+)?(?:deep\\s+|thorough\\s+|full\\s+|quick\\s+|little\\s+)?research\\s+(?:about|on|for|into)?\\s*`,
                'i',
            ),
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
    // Classifier with its own fallback chain: primary pinned client first,
    // then each configured classifier fallback. Returns raw text or null.
    // Never rotates keys and never throws — failure just means "next entry".
    async _classifyWithFallbacks(messages) {
        const r = await this._groqCall(messages, this.classifierModel, 5, 0, undefined, this._classifierClient).catch(
            () => null,
        )
        if (typeof r === 'string' && r) return r
        for (const fb of this.agentFallbacks?.classifier ?? []) {
            try {
                const client = this._fallbackClient(fb)
                if (!client) continue
                const payload = this._buildPayload(fb.model, messages, 5, 0, undefined, fb.baseUrl)
                const r2 = await client.chat.completions.create({ ...payload, stream: false })
                const out = r2.choices?.[0]?.message?.content
                if (typeof out === 'string' && out) return out
            } catch {}
        }
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
                content: `Does answering this accurately require a live web search?\n\nAnswer YES if: real-time/frequently changing data, events/releases/news from last 12 months, product reveals/announcements/launches tied to a named event/show/award (Monterey Car Week, CES, Grammys), especially with 'this year'/'this week', software/game version numbers, current position holders, step-by-step how-tos for current apps/sites (UIs change), recommendations of real people/creators/businesses/products/social-media handles (invented names and links mislead), anything where a 6-month-old answer would be wrong.\n\nAnswer NO if: conversational/emotional/social, asking for opinion/joke/creative content, timeless knowledge (math, history, stable how-things-work).\n\nReply ONLY YES or NO.\n\nQuestion: ${prompt.slice(0, 300)}`,
            },
        ]
        try {
            // Use a cheap fast model for YES/NO classification instead of big slow overthinking flasgship models (faster + cheaper)
            // (also which fires an unnecessary server-side web search just to answer YES/NO)
            const result = await Promise.race([
                this._classifyWithFallbacks(messages),
                new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2500)),
            ])
            if (!result || typeof result !== 'string') return this._heuristicNeedsResearch(prompt)
            return result.trim().toUpperCase().startsWith('YES')
        } catch {
            return this._heuristicNeedsResearch(prompt)
        }
    }

    // Best-effort guess when the classifier times out or errors: question-shaped
    // or version/recency-flavored prompts probably want live data, everything else
    // stays direct. Interpersonal/opinion frames ("do you like X?") are excluded
    // even with a question mark — researching taste is pure waste.
    _heuristicNeedsResearch(prompt) {
        const t = prompt.trim()
        if (/^(do you|are you|would you|will you|did you|have you|do u|what do you think|how do you feel|should i)\b/i.test(t)) {
            return /\b(20[2-9]\d|v?\d+\.\d+[\d.]*)\b/.test(t.toLowerCase())
        }
        if (prompt.includes('?')) return true
        return /\b(20[2-9]\d|v?\d+\.\d+[\d.]*)\b/.test(prompt.toLowerCase())
    }

    async needsResearch(prompt) {
        const lower = prompt.toLowerCase().trim()
        const wc = prompt.split(/\s+/).length
        const hasQ = prompt.includes('?')
        const hasTemp = /\b(20[2-9]\d|v?\d+\.\d+[\d.]*)\b/.test(lower)

        for (const sig of NO_SEARCH_SIGNALS) if (lower.includes(sig)) return 'nosearch'
        // Censor toggle (config.json "nsfw"): with it off, NSFW/dangerous prompts
        // short-circuit to refusals. With it on, everything routes normally and
        // the models judge content themselves.
        if (!this._nsfwAllowed()) {
            // Word-boundaried: substring matching refused whole queries ("hololive"
            // contains "loli"). Standalone terms still match exactly as before.
            if (NSFW_RE.test(lower)) return 'nsfw'
            for (const term of DANGEROUS_TERMS) if (lower.includes(term)) return 'dangerous'
        }
        for (const s of ALWAYS_LIVE) if (lower.includes(s)) return 'research'

        // Greeting-led messages with no question mark and no live signal are social,
        // not research. Decided here so archaic/casual hellos ("ho, nice to meeteth
        // thee…") never burn a classifier call that small models false-positive on.
        if (!hasQ && /^(hi+|hey+|ho+|hello|hiya|heyo|howdy|salut|yo|sup|oi)\b[,!\s]/i.test(prompt.trim()))
            return 'direct'

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

        // Classifier round-trip, cache for 2 min so spam of "what's the weather"
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
