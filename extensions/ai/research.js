// Research layer: serper/tavily tool loop, source parsing, and the
// three-stage needsResearch router (signal lists -> cheap classifier).
import { LRUCache } from 'lru-cache'
import { DANGEROUS_TERMS, NO_SEARCH_SIGNALS, NSFW_RE } from './constants.js'
import { ProviderCore } from './providers.js'
import { FairQueue, estTokens } from './fairqueue.js'
import { staticCaps } from './capabilities.js'
import { classifyResearchStatic } from './hot-kernels.js'
import { loadPerformance } from '../performance.js'

const _escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const NO_SEARCH_TEST_RE = new RegExp(`(?:${NO_SEARCH_SIGNALS.map(_escRe).join('|')})`, 'i')
const DANGEROUS_RE = new RegExp(`(?:${[...DANGEROUS_TERMS].map(_escRe).join('|')})`, 'i')
const SELF_METRIC_1 =
    /^(?:your|ur|medusa'?s?|bot'?s?|her)\s+(?:ram|memory|cpu|uptime|ping|latency|status|vitals|lag|health)\b/i
const SELF_METRIC_2 = /^(?:ram|memory|cpu|uptime|ping|vitals)\b[^a-z]*\??$/i
const SELF_METRIC_3 = /^(?:ram|memory|cpu)\s+(?:usage|use|load|status|state|level)\b/i
const SELF_METRIC_4 = /\bhow much (?:ram|memory) (?:do you|u have|have you got)\b/i
const SELF_METRIC_5 = /\b(?:you|u|she|medusa) (?:lagging|laggy|slow|down|dead)\b/i
const PRODUCT_NOUN_RE =
    /\b(?:20[2-9]\d|v?\d+\.\d+|benchmark|price|cost|vs\b|compare|game|pc\b|phone|laptop|gpu)\b/i

// Query-strip patterns, built once: _extractSearchQuery rebuilt all 14 on
// every research message. The (you|u|ya) alternation is inlined statically.
const _YOU = '(?:you|u|ya)'
const SEARCH_STRIP_RES = [
    new RegExp(
        `^(?:do|perform|conduct)\\s+(?:a\\s+)?(?:deep\\s+|thorough\\s+|full\\s+|quick\\s+|little\\s+)?research\\s+(?:about|on|for|into)?\\s*`,
        'i',
    ),
    new RegExp(
        `^(?:can ${_YOU}\\s+|could ${_YOU}\\s+)?(?:please\\s+)?(?:make a\\s+|do a\\s+|make\\s+|do\\s+)?research\\s+(?:about|on|for)\\s+`,
        'i',
    ),
    new RegExp(
        `^(?:can ${_YOU}\\s+|could ${_YOU}\\s+)?(?:please\\s+)?search\\s+(?:(?:up|for|it|this|that|me)\\b\\s*)+`,
        'i',
    ),
    new RegExp(`^(?:can ${_YOU}\\s+|could ${_YOU}\\s+)?(?:please\\s+)?look\\s+up\\s+`, 'i'),
    new RegExp(`^(?:can ${_YOU}\\s+|could ${_YOU}\\s+)?(?:please\\s+)?lookup\\s+`, 'i'),
    new RegExp(`^(?:can ${_YOU}\\s+|could ${_YOU}\\s+)?(?:please\\s+)?find(?:\\s+me)?\\s+`, 'i'),
    new RegExp(`^(?:can ${_YOU}\\s+|could ${_YOU}\\s+)?(?:please\\s+)?tell me about\\s+`, 'i'),
    new RegExp(`^(?:can ${_YOU}\\s+|could ${_YOU}\\s+)?(?:please\\s+)?tell me\\s+`, 'i'),
    new RegExp(`^(?:can ${_YOU}\\s+|could ${_YOU}\\s+)?(?:please\\s+)?give me\\s+`, 'i'),
    new RegExp(`^(?:can ${_YOU}\\s+|could ${_YOU}\\s+)?(?:please\\s+)?list\\s+`, 'i'),
    new RegExp(`^(?:can ${_YOU}\\s+|could ${_YOU}\\s+)?(?:please\\s+)?what(?:'s| is)\\s+`, 'i'),
    new RegExp(`^(?:can ${_YOU}\\s+|could ${_YOU}\\s+)?(?:please\\s+)?who(?:'s| is)\\s+`, 'i'),
    new RegExp(
        `^(?:can ${_YOU}\\s+|could ${_YOU}\\s+)?(?:please\\s+)?google\\s+(?:(?:it|this|that|for\\s+me)\\b\\s*)+`,
        'i',
    ),
    new RegExp(`^(?:can ${_YOU}\\s+|could ${_YOU}\\s+)?(?:please\\s+)?show me\\s+`, 'i'),
    /^research\s+(?:it\s+up|this\s+up|that\s+up|for\s+me|about|on\b)\s*/i,
]

const PERF = loadPerformance()

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
    async _callResearch(prompt, fairCtx = null) {
        // Fair-share: research calls are the heaviest per unit (retrieved
        // context + tool rounds). Null fairCtx = ungated (background paths).
        // Factory mode: concurrent identical research shares one flight.
        // Clean once here so every search path (direct, tool loop, fallback
        // hops) queries the topic, not the command wrapping ("tell me",
        // "(look it up)"). Callers keep the raw prompt for synthesis.
        prompt = this._extractSearchQuery(prompt)
        const run = async () => {
            // Tavily once per turn, not once per fallback hop: the query is
            // identical for primary + fallbacks, so re-searching burns up to
            // 4 credits per failed turn for the same results.
            const pre = await this._tavilyDirect(prompt)
            if (this._researchClient) {
                const out = await this._callResearchWith(
                    this._researchClient,
                    this.researchModel,
                    prompt,
                    true,
                    false,
                    pre,
                )
                if (out) return out
            }
            for (const fb of this.agentFallbacks?.research ?? []) {
                // Same model on the same provider the primary just tried:
                // re-hitting it burns a hop for identical results.
                if (
                    fb.model === this.researchModel &&
                    fb.baseUrl === this._config?.agents?.research?.resolved?.baseUrl
                )
                    continue
                try {
                    const client = this._fallbackClient(fb)
                    if (!client) continue
                    const out = await this._callResearchWith(client, fb.model, prompt, false, false, pre)
                    if (out) {
                        console.log(
                            `[AI] Research fallback answered via ${fb.provider ?? fb.baseUrl} / ${fb.model}`,
                        )
                        return out
                    }
                } catch {}
            }
            return null
        }
        if (!fairCtx || PERF.ai.fairShare === false) return await run()
        this._fair ??= new FairQueue()
        const fair = await this._fair.acquire({
            guildId: fairCtx.guildId ?? 'dm',
            tokens: estTokens(String(prompt ?? '').length, this.searchTokens ?? 1500, 0),
            priority: fairCtx.priority === true,
            coalesceKey: FairQueue.keyFor(this.researchModel, [{ role: 'user', content: prompt }]),
            run,
        })
        if (!fair.ok) return null
        return await fair.shared
    }

    // Direct Tavily search+answer with no LLM round trip. Returns a results
    // block or null (no client yet, rate-limited, empty). The caller owns
    // synthesis; this function only retrieves.
    async _tavilyDirect(prompt) {
        try {
            if (!this._tavily) return null
            const tr = await this._tavily.search(String(prompt ?? '').slice(0, 500), {
                maxResults: 5,
                searchDepth: 'basic',
                includeAnswer: true,
                timeout: 8,
            })
            const snippets = (tr.results ?? [])
                .map((r, i) => {
                    const pub = r.publishedDate ?? r.published_date
                    const date = pub ? ` (published ${String(pub).slice(0, 10)})` : ''
                    return `[${i + 1}] ${r.title}${date}\n${(r.content ?? '').slice(0, 400)}\nURL: ${r.url}`
                })
                .join('\n\n')
            const answer = tr.answer ?? ''
            const body = `${answer ? `Quick answer: ${answer}\n\n` : ''}${snippets}`.trim()
            return body.length > 40 ? `Question: ${prompt}\n\n${body}` : null
        } catch {
            return null
        }
    }

    // One full tool-loop run against a specific client+model. Key rotation
    // only happens for the primary (allowRotate); fallbacks just move on.
    async _callResearchWith(client, model, prompt, allowRotate, _retried = false, pre = undefined) {
        if (!client) return null

        const serperKey = (this._config ?? this.config).search?.serperKey
        const tavilyKey = (this._config ?? this.config).search?.tavilyKey

        // Tavily-primary: one direct search+answer call first, then a SINGLE
        // synthesis round — instead of up to 4 model rounds each possibly
        // fetching.
        const direct = pre === undefined ? await this._tavilyDirect(prompt) : pre

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
                    'You are a precise research assistant. Use the web_search tool to find current information when needed. Synthesize results factually, weighing the newest sources heaviest — flag stale or conflicting info with as-of dates. End with: SOURCES: [Name](url), max 3 real URLs. Omit if none.',
            },
            { role: 'user', content: String(prompt ?? '').slice(0, 800) },
        ]

        const hasSearch = !!(serperKey || tavilyKey)

        try {
            if (direct) {
                try {
                    const r = await client.chat.completions.create({
                        model,
                        messages: [
                            {
                                role: 'system',
                                content:
                                    'Answer the question using ONLY the search results below. Be factual and concise. End with: SOURCES: [Name](url), max 3 real URLs from the results. Omit if none.',
                            },
                            { role: 'user', content: direct.slice(0, 6000) },
                        ],
                        max_completion_tokens: this.searchTokens,
                        temperature: 0.3,
                        top_p: this.topP,
                        ...(this._isLowEffortReasoning(model) ? { reasoning_effort: 'low' } : {}),
                    })
                    const content = r.choices?.[0]?.message?.content
                    if (content?.trim()) return content
                } catch (e) {
                    // Propagate 429/key errors to main catch so primary rotates research keys
                    if (this._isKeyError(e)) throw e
                }
                // Synthesis failed: fall through to the tool loop below — unless
                // Tavily already ran this turn and Serper isn't configured, in
                // which case the loop would just re-run the same dead search.
                if (pre !== undefined && !serperKey) return null
            }

            // Native-first: models with server-side browsing answer directly — inside
            // main try/catch so 429s rotate keys and trigger fallbacks cleanly.
            if (staticCaps(model).webSearch === true) {
                try {
                    const r = await client.chat.completions.create({
                        model,
                        messages,
                        max_completion_tokens: this.searchTokens,
                        temperature: this.researchTemp,
                        top_p: this.topP,
                        ...(this._isLowEffortReasoning(model) ? { reasoning_effort: 'low' } : {}),
                    })
                    const content = r.choices?.[0]?.message?.content
                    if (content?.trim()) {
                        if (this._config?.debug) console.log(`[AI] Research native-search via ${model}`)
                        return content
                    }
                } catch (e) {
                    if (!hasSearch || this._isKeyError(e)) throw e
                    console.warn(
                        `[AI] Native search failed on ${model}, Tavily loop fallback:`,
                        String(e?.message ?? e).slice(0, 100),
                    )
                }
            }

            // Bounded tool-calling loop. Tools stay attached on every round so tool_choice is
            // never implicitly "none" while the model might still emit a call.
            const MAX_ROUNDS = 4
            const convo = [...messages]
            let toolDataSeen = false
            const NO_DATA_RE = /^(No results found\.|No results\.|Search failed:|No external search tool)/
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
                        ...(this._isLowEffortReasoning(model) ? { reasoning_effort: 'low' } : {}),
                    })
                let r
                try {
                    r = await runRound(hasSearch)
                } catch (err) {
                    if (!(hasSearch && this._isToolCallError(err))) throw err
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
                    if (!toolDataSeen && convo.some((m) => m.role === 'tool')) return null
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
                                if (!res.ok) throw new Error(`Serper HTTP ${res.status}`)
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
                                const tr = await this._tavily.search(query, {
                                    maxResults: 5,
                                    searchDepth: 'basic',
                                    includeAnswer: true,
                                    timeout: 8,
                                })
                                const snippets = (tr.results ?? [])
                                    .map((r, i) => {
                                        const pub = r.publishedDate ?? r.published_date
                                        const date = pub ? ` (published ${String(pub).slice(0, 10)})` : ''
                                        return `[${i + 1}] ${r.title}${date}\n${(r.content ?? '').slice(0, 400)}\nURL: ${r.url}`
                                    })
                                    .join('\n\n')
                                result = tr.answer
                                    ? `Quick answer: ${tr.answer}\n\n${snippets}`
                                    : snippets || 'No results.'
                            } else {
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
                if (toolResults.some((tr) => tr.content && !NO_DATA_RE.test(tr.content))) toolDataSeen = true
                convo.push(...toolResults)
            }

            // Round cap reached without a plain-text answer, force one final synthesis pass.
            if (!toolDataSeen) return null
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
                return this._callResearchWith(
                    this._researchClient,
                    this.researchModel,
                    prompt,
                    allowRotate,
                    true,
                    direct,
                )
            }
            return null
        }
    }

    _parseSources(raw) {
        if (!raw || typeof raw !== 'string') return { text: '', sources: [] }
        // Match the final SOURCES: footer block so an earlier prose mention of "Sources:" doesn't truncate the reply.
        const headerRe = /(?:^|\n)\s*\*?\*?SOURCES?\*?\*?:\s*/gi
        let lastMatch = null
        let m
        while ((m = headerRe.exec(raw)) !== null) lastMatch = m
        if (!lastMatch) return { text: raw.trim(), sources: [] }

        const text = raw.slice(0, lastMatch.index).trim()
        const block = raw.slice(lastMatch.index + lastMatch[0].length)
        const sources = [...block.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g)]
            .slice(0, 3)
            .map((mm) => ({ name: mm[1].trim(), url: mm[2].trim() }))
        // The model sometimes cites bare URLs instead of markdown links — harvest
        // those from the SOURCES block so research answers don't silently lose
        // their footer.
        if (!sources.length) {
            const seen = new Set()
            for (const mm of block.matchAll(/https?:\/\/[^\s)>\]]+/g)) {
                const url = mm[0].slice(0, 300)
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
        const raw = String(prompt ?? '').trim()
        if (!raw) return ''
        let q = raw
        // Strip leading greetings and filler words
        q = q.replace(/^(?:hi+|hey+|yo+|sup|hello|oi|ok|okay)[,!\s]+/i, '').trim()
        // Trailing instruction verbs ("fake info do web research"): the
        // ask is the topic, the verb phrase is not.
        q = q
            .replace(/(?:^|\s+)(?:do|perform|run|make)(?: a)?\s+web\s+(?:research|search)\s*\.?$/i, '')
            .trim()
        // Strip trailing "…and research" / "…research for me" so the query stays clean.
        q = q
            .replace(/\s+and\s+research(?:\s+for\s+me|\s+it\s+up|\s+this\s+up|\s+that\s+up)?\.?$/i, '')
            .replace(/\s+research\s+(?:for\s+me|it\s+up|this\s+up|that\s+up)\.?$/i, '')
            .trim()
        for (const p of SEARCH_STRIP_RES) q = q.replace(p, '').trim()
        q = q.replace(/\s+for me\.?$|\s+please\.?$/i, '').trim()
        // Parenthetical asides to the bot ("(look it up)", "(search this)")
        // are instructions, not search terms — drop them from the query.
        q = q
            .replace(
                /\(\s*(?:look(?: it)? up|search(?: it)?(?: up)?|research(?: this)?|google(?: it)?|find(?: it)?(?: that)?(?: out)?)\s*\)/gi,
                '',
            )
            .replace(/\s{2,}/g, ' ')
            .trim()
        return q.length > 3 ? q : raw
    }

    // Classifier with its own fallback chain: primary pinned client first,
    // then each configured classifier fallback. Returns raw text or null.
    async _classifyWithFallbacks(messages, ctl = null) {
        const toks = this.classifierTokens ?? 64
        const r = await this._groqCall(
            messages,
            this.classifierModel,
            toks,
            0,
            undefined,
            this._classifierClient,
            this._effortIntent('classifier'),
        ).catch(() => null)
        if (typeof r === 'string' && r) return r
        for (const fb of this.agentFallbacks?.classifier ?? []) {
            if (ctl?.stop) return null
            if (fb.model === this.classifierModel) continue
            try {
                const client = this._fallbackClient(fb)
                if (!client) continue
                const payload = this._buildPayload(
                    fb.model,
                    messages,
                    toks,
                    0,
                    undefined,
                    fb.baseUrl,
                    this._effortIntent('classifier'),
                )
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
                content: `Does answering this accurately require a live web search?\n\nAnswer YES if: real-time/frequently changing data, events/releases/news from last 12 months, product reveals/announcements/launches tied to a named event/show/award (Monterey Car Week, CES, Grammys), especially with 'this year'/'this week', software/game version numbers, current position holders, step-by-step how-tos for current apps/sites (UIs change), recommendations of real people/creators/businesses/products/social-media handles (invented names and links mislead), anything where a 6-month-old answer would be wrong.\n\nAnswer NO if: conversational/emotional/social, asking for opinion/joke/creative content, timeless knowledge (math, history, stable how-things-work).\n\nReply ONLY YES or NO.\n\nQuestion: ${String(prompt ?? '').slice(0, 300)}`,
            },
        ]
        let timer = null
        try {
            const ctl = { stop: false }
            const result = await Promise.race([
                this._classifyWithFallbacks(messages, ctl),
                new Promise((_, rej) => {
                    timer = setTimeout(() => {
                        ctl.stop = true
                        rej(new Error('timeout'))
                    }, 2500)
                }),
            ])
            if (!result || typeof result !== 'string') return this._heuristicNeedsResearch(prompt)
            return result.trim().toUpperCase().startsWith('YES')
        } catch {
            return this._heuristicNeedsResearch(prompt)
        } finally {
            if (timer) clearTimeout(timer)
        }
    }

    // Best-effort guess when the classifier times out or errors: question-shaped
    // or version/recency-flavored prompts probably want live data, everything else
    // stays direct. Interpersonal/opinion frames ("do you like X?") are excluded
    // even with a question mark — researching taste is pure waste.
    _heuristicNeedsResearch(prompt) {
        const t = String(prompt ?? '').trim()
        if (
            /^(do you|are you|would you|will you|did you|have you|do u|what do you think|how do you feel|should i)\b/i.test(
                t,
            )
        ) {
            return /\b(20[2-9]\d|v?\d+\.\d+[\d.]*)\b/.test(t.toLowerCase())
        }
        if (t.includes('?')) return true
        return /\b(20[2-9]\d|v?\d+\.\d+[\d.]*)\b/.test(t.toLowerCase())
    }

    async needsResearch(prompt) {
        // Master switch off: everything answers directly, classifier never runs.
        if (this._searchOff()) return 'direct'
        const raw = String(prompt ?? '')
        // Pre-resolved by a fast-path (time data, explicit context): answering
        // directly, never researching what we already computed.
        if (raw.includes('[TIME DATA')) return 'direct'
        const trimmed = raw.trim()
        const lower = trimmed.toLowerCase()

        if (NO_SEARCH_TEST_RE.test(lower)) return 'nosearch'

        // Self-status: "ram usage?", "cpu?", "uptime", "ping", "vitals"
        const selfMetric =
            SELF_METRIC_1.test(trimmed) ||
            SELF_METRIC_2.test(trimmed) ||
            SELF_METRIC_3.test(trimmed) ||
            SELF_METRIC_4.test(lower) ||
            SELF_METRIC_5.test(lower)
        if (selfMetric && !PRODUCT_NOUN_RE.test(lower)) return 'nosearch'

        // Censor toggle (config.json "nsfw"): with it off, NSFW/dangerous prompts
        // short-circuit to refusals.
        if (!this._nsfwAllowed()) {
            if (NSFW_RE.test(lower)) return 'nsfw'
            if (DANGEROUS_RE.test(lower)) return 'dangerous'
        }

        const staticDecision = classifyResearchStatic(raw, false)
        if (staticDecision === 'yes') return 'research'
        if (staticDecision === 'no') return 'direct'

        // Classifier round-trip, cache for 2 min so spam of "what's the weather"
        // doesn't burn 30 LLM calls in a fun channel
        this._routeCache ??= new LRUCache({ max: 500, ttl: 120_000 })
        const cacheKey = lower.slice(0, 200)
        const hit = this._routeCache.get(cacheKey)
        if (hit !== undefined) return hit
        const needsIt = await this._classifyNeedsResearch(raw)
        const result = needsIt ? 'research' : 'direct'
        this._routeCache.set(cacheKey, result)
        return result
    }
}
