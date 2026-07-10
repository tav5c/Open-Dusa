// Provider layer: OpenAI-compatible clients, priority routing across providers[],
// key rotation with cooldowns, circuit breakers, payload shaping, streaming.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import OpenAI from 'openai'
import { Agent } from 'undici'
import { DEAD_KEYS_FILE } from './constants.js'

export const _undiciAgent = new Agent({
    connections: 30,
    pipelining: 4,
    keepAliveTimeout: 60_000,
    keepAliveMaxTimeout: 300_000,
    connectTimeout: 8_000,
    headersTimeout: 15_000,
    bodyTimeout: 60_000,
})

export class ProviderCore {
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
                    'HTTP-Referer': this._config?.siteUrl || 'https://medusa.bot',
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

            const research = this._config.agents.research.resolved
            this._researchClient = research?.baseUrl
                ? createClient(research.baseUrl, this.researchKeys[this.currentResearchKeyIdx ?? 0] ?? key, 60_000, 1)
                : this._groqResearch

            // Dedicated clients for agents pinned to a different provider than chat
            const agentClient = (agent, timeout) =>
                agent.resolved?.keys?.length && agent.resolved.baseUrl !== this.llmBaseUrl
                    ? createClient(agent.resolved.baseUrl, agent.resolved.keys[0], timeout, 0)
                    : null
            this._visionClient = agentClient(this._config.agents.vision, 30_000)
            this._classifierClient = agentClient(this._config.agents.classifier, 8_000)
        } catch (e) {
            console.error('[AI] LLM client init failed:', e)
            this._groq = null
            this._groqResearch = null
            this._researchClient = null
        }

        // Optional Tavily client — wakes up the `else if (this._tavily)` branch in _callResearch.
        // Dynamic import via .then() because _initGroq is synchronous (called from constructor).
        const tavilyKey = (this._config ?? this.config).search?.tavilyKey
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
     * Priority router pool from config.providers[] (normalized + priority-sorted by
     * config.js). A keyless providers list still boots: the chat agent's resolved
     * client becomes a single-entry pool. Each provider gets its own breaker state.
     */
    _initProviders() {
        const pool = this._config?.providers?.filter((p) => p.keys?.length)
        const list = pool?.length
            ? pool
            : [{ name: 'default', baseUrl: this.llmBaseUrl, keys: this.aiTokens, model: this.aiModel, priority: 1 }]

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
                p.client = new OpenAI({ apiKey: key, baseURL: p.baseUrl, timeout: 12_000, maxRetries: 0 })
            } catch (e) {
                p.client = null
                if (this._config?.debug) console.warn(`[AI] Provider '${p.name}' client init failed: ${e.message}`)
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
                    ...this._buildPayload(p.model ?? this.aiModel, messages, maxTokens, temp, topP, p.baseUrl),
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
                if (this._config?.debug)
                    console.warn(`[AI] Provider '${p.name}' failed (${e?.status ?? 'no-status'}): ${err.slice(0, 120)}`)
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

    _detectProvider(model, baseUrl = this.llmBaseUrl) {
        const url = baseUrl || ''
        // ProviderCore owns the static (this file) — the old monolith class name no longer exists here.
        return ProviderCore.PROVIDERS.find((p) => p.match(url, model))
    }

    _buildPayload(model, messages, maxTokens, temp, topP, baseUrl = this.llmBaseUrl) {
        let payload = {
            model,
            messages,
            temperature: temp ?? this.temperature,
            top_p: topP ?? this.topP,
        }
        const provider = this._detectProvider(model, baseUrl)
        payload = provider.paramMap(payload, maxTokens ?? this.chatTokens)

        // Reasoning models (OpenAI o1/o3, DeepSeek-R, gpt-oss)
        if (/\bo[13]\b|deepseek-r|gpt-oss/i.test(model)) {
            payload.reasoning_effort = 'low'
            if (!/gpt-oss/i.test(model)) {
                delete payload.temperature
                delete payload.top_p
            }
        }

        if (this._config?.stopSequences?.length) payload.stop = this._config.stopSequences
        if (this._config?.streaming === true) payload.stream = true

        return payload
    }

    async _groqCall(messages, model, maxTokens, temp, topP, client = null) {
        const pinned = client
        client ??= this._groq
        if (!client) return null

        const payload = this._buildPayload(model, messages, maxTokens, temp, topP)
        try {
            const r = await client.chat.completions.create(payload)
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
                        const r2 = await (pinned ?? this._groq).chat.completions.create(payload)
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
}
