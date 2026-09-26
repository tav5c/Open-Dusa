// Provider layer: OpenAI-compatible clients, priority routing across providers[],
// key rotation with cooldowns, circuit breakers, payload shaping, streaming.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import OpenAI from 'openai'
import { Agent } from 'undici'
import { DEAD_KEYS_FILE } from './constants.js'

// Tavily client pool: same `.search()` shape as a single client, rotates to
// the next key on rate-limit/quota errors. Pure factory for testability.
export function createTavilyPool(tavily, keys) {
    let idx = 0
    const clients = keys.map((k) => tavily({ apiKey: k }))
    if (!clients.length) throw new Error('[AI] Tavily pool needs at least one key')
    const retryable = (e) =>
        /429|rate.?limit|quota|too many|insufficient|credit|401|403|unauthorized|invalid.*key/.test(
            String(e?.message ?? e).toLowerCase(),
        )
    return {
        size: clients.length,
        search: async (...args) => {
            let err = null
            // Walk the whole ring from the current key: a dead first key
            // (bad/expired key, spent quota) shouldn't burn the spares
            // sitting behind it, and non-retryable errors pass through.
            for (let step = 0; step < clients.length; step++) {
                const i = (idx + step) % clients.length
                try {
                    const out = await clients[i].search(...args)
                    if (step > 0) {
                        idx = i
                        console.warn(`[AI] Tavily key rotated (${idx + 1}/${clients.length})`)
                    }
                    return out
                } catch (e) {
                    err = e
                    if (!retryable(e)) break
                }
            }
            throw err
        },
    }
}

export const _undiciAgent = new Agent({
    connections: 30,
    pipelining: 1,
    keepAliveTimeout: 60_000,
    keepAliveMaxTimeout: 300_000,
    connectTimeout: 8_000,
    // undici defaults (300 s): per-call budgets stay on the openai SDK
    // timeouts / AbortSignal, which always fire first. A low ceiling here
    // would truncate @discordjs/rest traffic (it imports undici directly);
    // pipelining 1 avoids head-of-line blocking on long requests.
    headersTimeout: 300_000,
    bodyTimeout: 300_000,
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
            // maxRetries 0 like every other client: the SDK's blind retry would
            // re-fire into the same limited key and delay retry-after-aware
            // rotation. Manual chain (_callResearchWith) owns all retries.
            this._researchClient = research?.baseUrl
                ? createClient(
                      research.baseUrl,
                      this.researchKeys[this.currentResearchKeyIdx ?? 0] ?? key,
                      60_000,
                      0,
                  )
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

        // Optional Tavily client pool, wakes up the `else if (this._tavily)` branch in _callResearch.
        // Dynamic import via .then() because _initGroq is synchronous (called from constructor).
        // Multiple keys rotate on rate-limit/quota errors; a single string still works.
        const tavilyKeys = (this._config ?? this.config).search?.tavilyKeys ?? []
        const firstTavily = tavilyKeys[0] ?? (this._config ?? this.config).search?.tavilyKey
        if (firstTavily && !this._tavily) {
            import('@tavily/core')
                .then(({ tavily }) => {
                    const pool = tavilyKeys.length ? tavilyKeys : [firstTavily]
                    this._tavily = createTavilyPool(tavily, pool)
                    console.log(
                        `[AI] Tavily client initialized (${pool.length} key${pool.length === 1 ? '' : 's'})`,
                    )
                })
                .catch((e) => {
                    console.warn('[AI] Tavily import failed, run `npm i @tavily/core` to enable:', e.message)
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
            : [
                  {
                      name: 'default',
                      baseUrl: this.llmBaseUrl,
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
            p.state.keyIdx ??= 0
            const key = (p.keys ?? [])[p.state.keyIdx] ?? (p.keys ?? [])[0]
            if (!key) {
                p.client = null
                continue
            }
            try {
                p.client = new OpenAI({ apiKey: key, baseURL: p.baseUrl, timeout: 12_000, maxRetries: 0 })
            } catch (e) {
                p.client = null
                if (this._config?.debug)
                    console.warn(`[AI] Provider '${p.name}' client init failed: ${e.message}`)
            }
        }
    }

    _tripBreaker(p, err, openMs = 60_000) {
        p.state.failures++
        if (p.state.failures >= 3) {
            p.state.openUntil = Date.now() + openMs // half-open once the window passes
            p.state.failures = 0
            console.warn(
                `[AI] Provider '${p.name}' circuit OPEN for ${Math.round(openMs / 1000)}s (${String(err).slice(0, 80)})`,
            )
        }
    }

    _resetBreaker(p) {
        if (p.state.failures || p.state.openUntil) {
            p.state.failures = 0
            p.state.openUntil = 0
        }
    }

    // Groq 429 bodies say exactly how long to back off ("Please try again in 1m34.608s",
    // "...in 7.66s", "...in 2h3m"). Believe them instead of guessing a flat cooldown:
    // a TPD 429 treated like a TPM one just comes straight back after 30s all day.
    _errorStatus(err) {
        const direct = Number(err?.status ?? err?.statusCode ?? err?.response?.status)
        if (Number.isInteger(direct) && direct >= 400 && direct <= 599) return direct
        const match = String(err).match(/(?:error code:|status(?: code)?[:=]?|\b)(4\d\d|5\d\d)\b/i)
        return match ? Number(match[1]) : null
    }

    _parseRetryMs(err) {
        const headers = err?.headers ?? err?.response?.headers
        const retryAfter = headers?.get?.('retry-after') ?? headers?.['retry-after']
        if (retryAfter != null) {
            const seconds = Number(retryAfter)
            if (Number.isFinite(seconds))
                return Math.min(Math.max(Math.ceil(seconds * 1000) + 1000, 5_000), 6 * 3600_000)
            const at = Date.parse(retryAfter)
            if (Number.isFinite(at)) return Math.min(Math.max(at - Date.now() + 1000, 5_000), 6 * 3600_000)
        }
        const m = String(err).match(
            /try again in\s+(?:(\d+)h)?(?:(\d+)m(?!s))?(?:([\d.]+)s)?(?:([\d.]+)ms)?/i,
        )
        if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return 60_000
        const ms =
            (parseInt(m[1] ?? 0) * 3600 + parseInt(m[2] ?? 0) * 60 + parseFloat(m[3] ?? 0)) * 1000 +
            parseFloat(m[4] ?? 0)
        return Math.min(Math.max(Math.ceil(ms) + 1000, 5_000), 6 * 3600_000) // 5s floor, 6h cap
    }

    // Advance a router provider to its next usable key and rebuild its client.
    // Returns false when every key is still cooling down. Keys that come back
    // dead (restricted org, revoked key) are parked permanently instead of
    // cooling down and getting retried on the next cycle.
    _rotateProviderKey(p, retryMs, reason = 'key error', err = null) {
        const n = p.keys?.length ?? 0
        if (n < 2) return false
        p.state.keyIdx ??= 0
        p.state.keyCooldowns ??= new Map()
        p.state.deadKeys ??= new Set()
        if (err && this._isDeadKeyError(err)) {
            p.state.deadKeys.add(p.state.keyIdx)
            console.warn(
                `[AI] Provider '${p.name}' key ${p.state.keyIdx + 1} parked (dead: ${String(err?.message ?? err).slice(0, 80)})`,
            )
        } else {
            p.state.keyCooldowns.set(p.state.keyIdx, Date.now() + Math.max(retryMs, 5_000))
        }
        const now = Date.now()
        for (let step = 1; step <= n; step++) {
            const next = (p.state.keyIdx + step) % n
            if (p.state.deadKeys.has(next)) continue
            if ((p.state.keyCooldowns.get(next) ?? 0) > now) continue
            try {
                p.client = new OpenAI({
                    apiKey: p.keys[next],
                    baseURL: p.baseUrl,
                    timeout: 12_000,
                    maxRetries: 0,
                })
                console.log(
                    `[AI] Provider '${p.name}' key rotated: ${p.state.keyIdx + 1} -> ${next + 1} (${reason}, cooldown ${Math.round(retryMs / 1000)}s)`,
                )
                p.state.keyIdx = next
                return true
            } catch {}
        }
        return false
    }

    /**
     * Try each configured provider in priority order until one returns a non-null reply
     * or all of them are either circuit-open or exhausted. Capacity/503 errors don't count
     * against a provider as long as its other keys still respond. The requested model is
     * honored verbatim, providers already configured for it go first so chat doesn't burn
     * a doomed call (e.g. asking groq for xkiro's qwen model) on every single message.
     */
    async _routedCall(messages, model, maxTokens, temp, topP, budget = null, preferredBase = null) {
        if (!this._providers) this._initProviders()
        const now = Date.now()
        // Stable sort: the agent's pinned provider first (it owns this model family —
        // avoids a doomed cross-provider call when the slug is aggregator-specific,
        // e.g. OpenRouter-style `:free` suffixes that 404 elsewhere), then exact
        // model matches, otherwise priority order.
        preferredBase ??= this.llmBaseUrl
        const ordered = [...this._providers].sort((a, b) => {
            const pref = (b.baseUrl === preferredBase ? 1 : 0) - (a.baseUrl === preferredBase ? 1 : 0)
            if (pref !== 0) return pref
            return (b.priority ?? 99) - (a.priority ?? 99)
        })
        let attempts = 0
        // First-miss forensics: "Routed via x in Ns (2 attempts)" never says what
        // the first provider DID. Record it so "whats groq doing" has an answer.
        let firstFailure = null
        const noteFailure = (p, detail) => {
            if (!firstFailure) firstFailure = `${p.name} (${detail})`
        }
        for (const p of ordered) {
            // Hard per-reply cap: attempts share one deadline, and each
            // attempt gets at most what the budget has left.
            const remainMs = budget ? budget.until - Date.now() : Infinity
            if (remainMs < 1000) break
            // This reply already proved the base dead (stream-open timeout /
            // 5xx): skip it here too, not only in the fallback chain.
            if (budget?.dead.has(p.baseUrl)) {
                noteFailure(p, 'dead this reply')
                continue
            }
            if (!p.client) continue
            if (now < p.state.openUntil) {
                noteFailure(p, 'breaker open')
                continue // breaker open
            }
            attempts++
            // Same base + same model already attempted this reply (router hop
            // then legacy/fallback re-fire): skip the duplicate outright.
            const triedKey = `${p.baseUrl}|${model ?? this.aiModel}`
            if (budget?.tried?.has(triedKey)) {
                noteFailure(p, 'already tried this reply')
                continue
            }
            budget?.tried?.add(triedKey)
            const payload = {
                ...this._buildPayload(model ?? this.aiModel, messages, maxTokens, temp, topP, p.baseUrl),
                stream: false,
            }
            try {
                // Preferred provider gets a 25s ceiling: its TTFT routinely
                // exceeds the shared 12s client default, and a premature
                // timeout here burns the whole chain for a live-but-slow hop.
                // Never more than the budget has left, though.
                const ceiling = p.baseUrl === preferredBase ? 25_000 : 12_000
                const r = await p.client.chat.completions.create(payload, {
                    timeout: Math.min(ceiling, remainMs),
                })
                const out = r.choices?.[0]?.message?.content
                if (out) {
                    this._resetBreaker(p)
                    // Slow-provider forensics: a "slow ass" complaint is otherwise
                    // unprovable after the fact. Log whenever failover happened or
                    // a single provider took a while — including WHAT missed first.
                    const elapsed = Date.now() - now
                    if (attempts > 1 || elapsed > 8000) {
                        // Prefill size rides along so slow turns can be split
                        // into provider-side vs payload-side after the fact.
                        const prefill = messages.reduce((a, m) => a + String(m.content ?? '').length, 0)
                        console.log(
                            `[AI] Routed via '${p.name}' in ${(elapsed / 1000).toFixed(1)}s (${attempts} attempt${attempts === 1 ? '' : 's'}${firstFailure ? `, first miss: ${firstFailure}` : ''}, prefill ${(prefill / 1024).toFixed(1)}k chars)`,
                        )
                    }
                    return out
                }
                noteFailure(p, 'empty response')
                this._tripBreaker(p, 'empty response')
            } catch (e) {
                noteFailure(p, `HTTP ${this._errorStatus(e) ?? '?'} ${String(e?.message ?? e).slice(0, 60)}`)
                // Dead-provider marking: a timeout/network/5xx on one model
                // poisons the rest of this reply's chain, so skip sibling
                // entries on the same base. 404/429 stay per-entry — a
                // per-model miss must not kill a healthy provider.
                const st = this._errorStatus(e)
                if (budget && (st == null || st >= 500)) budget.dead.add(p.baseUrl)
                const err = String(e).toLowerCase()
                if (this._config?.debug)
                    console.warn(
                        `[AI] Provider '${p.name}' failed (${e?.status ?? 'no-status'}): ${err.slice(0, 120)}`,
                    )
                if (this._isCapacityError(e) || this._isRequestError(e)) continue // changing keys cannot fix these
                if (this._isBillingError(e)) {
                    // Wallet-level block (pay-as-you-go balance, promo credit that
                    // doesn't cover premium models): every key shares the wallet,
                    // so rotating would burn the whole ring for nothing. Open the
                    // breaker briefly, leave keys alone, say exactly what to do.
                    p.state.openUntil = Date.now() + 5 * 60_000
                    p.state.failures = 0
                    console.warn(
                        `[AI] Provider '${p.name}' billing-blocked (NOT key-specific — keys untouched): ${String(e?.message ?? e).slice(0, 160)} — deposit real balance or switch to a covered model.`,
                    )
                    continue
                }
                if (this._isKeyError(e)) {
                    // Burn through the whole key ring before giving up on this provider,
                    // each org has its own daily pool so the next key is a fresh wallet
                    let lastErr = e
                    let stopReason = null // null = walked the ring, every key cooling
                    const ring = p.keys?.length ?? 1
                    for (let hop = 1; hop < ring; hop++) {
                        const retryMs = this._parseRetryMs(lastErr)
                        const status = this._errorStatus(lastErr)
                        if (
                            !this._rotateProviderKey(
                                p,
                                retryMs,
                                status ? `HTTP ${status}` : 'key error',
                                lastErr,
                            )
                        )
                            break
                        try {
                            const r2 = await p.client.chat.completions.create(payload)
                            const out2 = r2.choices?.[0]?.message?.content
                            if (out2) {
                                this._resetBreaker(p)
                                const elapsed2 = Date.now() - now
                                if (elapsed2 > 8000) {
                                    console.log(
                                        `[AI] Routed via '${p.name}' after key burn in ${(elapsed2 / 1000).toFixed(1)}s (first miss: HTTP ${this._errorStatus(e) ?? '?'} ${String(e?.message ?? e).slice(0, 60)})`,
                                    )
                                }
                                return out2
                            }
                            stopReason = 'empty response'
                            break
                        } catch (e2) {
                            lastErr = e2
                            if (!this._isKeyError(e2)) {
                                stopReason = `non-rate error: ${String(e2).slice(0, 80)}`
                                break
                            }
                        }
                    }
                    if (stopReason) {
                        // Keys aren't the problem here, don't punish the whole provider for it
                        console.warn(
                            `[AI] Provider '${p.name}' key burn stopped (${stopReason}), trying next provider`,
                        )
                        continue
                    }
                    // Every key limited: open the breaker until the soonest key frees up
                    const cooldowns = [...(p.state.keyCooldowns?.values() ?? [])]
                    const wait = cooldowns.length
                        ? Math.min(...cooldowns) - Date.now()
                        : this._parseRetryMs(lastErr)
                    p.state.openUntil = Date.now() + Math.min(Math.max(wait, 5_000), 30 * 60_000)
                    p.state.failures = 0
                    console.warn(
                        `[AI] Provider '${p.name}' circuit OPEN for ${Math.round((p.state.openUntil - Date.now()) / 1000)}s (all keys rate-limited)`,
                    )
                    continue // fall through to the next provider right away
                }
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
            mkdirSync('data/logs', { recursive: true })
            writeFileSync(DEAD_KEYS_FILE, JSON.stringify({ dead_indices: [...this.deadKeys].sort() }))
        } catch {}
    }
    // Key rotation with per-key cooldown to prevent thrashing when all keys are rate-limited.
    // Without this, 2 limited keys ping-pong every few seconds burning logs and TTFT.
    async rotateKey(errorMsg = '') {
        if (this._rotatePromise) return this._rotatePromise

        this._rotatePromise = (async () => {
            // Billing blocks are wallet-level: rotating keys can't help, and must
            // not cool down healthy keys. Bail out and let the caller degrade.
            if (this._isBillingError(errorMsg)) {
                console.warn(`[AI] Billing-blocked, not rotating keys: ${String(errorMsg).slice(0, 160)}`)
                return false
            }
            const n = this.aiTokens.length
            if (!n) return false
            const old = this.currentKeyIdx
            this._keyCooldowns ??= new Map() // keyIdx -> timestamp when it becomes usable again

            if (this._isDeadKeyError(errorMsg)) {
                this.deadKeys.add(old)
                this._saveDeadKeys()
                console.log(`[AI] Key ${old + 1} permanently blacklisted`)
            } else if (this._isKeyError(errorMsg)) {
                // Cool the key down for as long as the provider actually asked for.
                // Floor is 5s (a fast re-hit costs ~1 RTT, not a stall); the old
                // 30s floor over-cooled by ~5x on Groq's typical "try again" hints.
                // If all keys are cooling down, we'll wait out the shortest one
                // rather than ping-ponging.
                this._keyCooldowns.set(old, Date.now() + Math.max(this._parseRetryMs(errorMsg), 5_000))
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
                    console.log(`[AI] Key rotated: ${old + 1} -> ${next + 1}`)
                    return true
                }
            }

            // All keys cooling down. Wait for the earliest one to recover rather than failing.
            const aliveCooldowns = [...this._keyCooldowns.entries()]
                .filter(([k]) => !this.deadKeys.has(k))
                .map(([, t]) => t)
            if (aliveCooldowns.length) {
                // Bounded wait: real retry-afters are seconds; anything past
                // 15s is a headerless default, and stalling an interactive
                // reply on it is worse than shedding to fallbacks/breather.
                const waitMs = Math.max(0, Math.min(...aliveCooldowns) - Date.now())
                if (waitMs > 0 && waitMs < 15_000) {
                    console.log(`[AI] All keys cooling down, waiting ${(waitMs / 1000).toFixed(1)}s`)
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

    // Censor toggle: config.json "nsfw". True = the models judge content
    // themselves; every code-level refusal below is bypassed. Defaults off.
    _nsfwAllowed() {
        return !!(this._config ?? this.config)?.nsfw || globalThis._medusaNsfw === true
    }
    // Billing blocks (pay-as-you-go wallet, credits, deposits) are PROVIDER-level,
    // never key-level: every key shares the same wallet, so rotating burns the
    // whole ring for nothing. Matched before _isKeyError so these skip rotation.
    _isBillingError(e) {
        const s = String(e?.message ?? e).toLowerCase()
        // Rate limits are NEVER billing, no matter what else the body says.
        // Groq TPM bodies keep going past the 160 chars we log ("...Limit N,
        // Used M... upgrade your plan... billing options") and that tail can
        // trip the wallet patterns below — so rate language wins outright.
        if (
            this._errorStatus(e) === 429 ||
            /(^|\D)(429|rate limit|too large|tokens per (minute|hour|day)|requests per|try again in|\btpm\b|\brpm\b|\brpd\b|service tier|rate-limits?)\b/.test(
                s,
            )
        )
            return false
        return /pay.as.you.go|deposited balance|promotional|bonus credit|insufficient.*(balance|credit|fund)|wallet|payment required|requires (more |real )?credits?|out of credits|billing/i.test(
            s,
        )
    }
    _isRateError(e) {
        const s = String(e).toLowerCase()
        const status = this._errorStatus(e)
        if (status === 429) return true
        if (status && status !== 429) return false
        return ['rate limit', 'quota exceeded', 'too many requests', 'limit exceeded'].some((x) =>
            s.includes(x),
        )
    }
    _isKeyError(e) {
        if (this._isRateError(e)) return true
        const status = this._errorStatus(e)
        if (status === 401 || status === 403) return true
        const s = String(e).toLowerCase()
        return [
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
        ].some((x) => s.includes(x))
    }
    _isRequestError(e) {
        return [400, 404, 413, 422].includes(this._errorStatus(e))
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
    // Research master switch (config search.enabled:false): every web
    // path checks this, so one flag quiets chat routing, slash commands,
    // and second thoughts together. Defaults on.
    _searchOff() {
        return (this._config ?? this.config)?.search?.enabled === false
    }
    _isCapacityError(e) {
        const s = String(e).toLowerCase()
        const status = this._errorStatus(e)
        return (
            status === 498 ||
            status === 529 ||
            (status === 503 &&
                (s.includes('over capacity') ||
                    s.includes('service unavailable') ||
                    s.includes('currently unavailable') ||
                    s.includes('capacity')))
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
        // ProviderCore owns the static (this file), the old monolith class name no longer exists here.
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
        // Single source of truth: _buildPayload never sets stream. _streamChat
        // sets stream:true explicitly; every other caller forces stream:false
        // after the spread. The old `streaming === true` line here silently
        // streamed non-stream readers (.choices[0]) into nulls.

        return payload
    }

    async _groqCall(messages, model, maxTokens, temp, topP, client = null) {
        const pinned = client
        client ??= this._groq
        if (!client) return null

        const payload = this._buildPayload(model, messages, maxTokens, temp, topP)
        // _groqCall is ALWAYS non-streaming (_streamChat owns streaming): force
        // it, because _buildPayload sets stream:true when global streaming is
        // on, and reading .choices[0] off a stream response throws -> null.
        // That silent null broke the classifier path whenever streaming was on.
        payload.stream = false
        try {
            const r = await client.chat.completions.create(payload)
            return r.choices[0].message.content
        } catch (e) {
            const err = String(e)
            if (this._isCapacityError(e)) return { capacityError: true }
            if (this._isRequestError(e)) return null

            if (this._isKeyError(e)) {
                // Check if we have multiple keys to rotate through. If only 1 key, we must respect retry-after.
                // Capped at 15s: genuine retry-afters are seconds; beyond that,
                // shed to fallbacks instead of stalling the reply.
                // Never for pinned clients (classifier/vision on their own
                // provider): the failing key isn't from aiTokens, and the wait
                // outlives the 2.5s classifier race as a dangling sleeper.
                if (!pinned && this.aiTokens.length <= 1 && !this._isDeadKeyError(err)) {
                    const waitMs = Math.min(this._parseRetryMs(e), 15_000)
                    console.log(`[AI] 429 retry-after: waiting ${waitMs}ms (only 1 key available)`)
                    await new Promise((r) => setTimeout(r, waitMs))
                }
                // Pinned clients (classifier/vision on their own provider) must
                // never rotate the shared chat ring: a classifier 429 would
                // otherwise cool down chat keys it never uses.
                if (!pinned && (await this.rotateKey(err))) {
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
    // Streaming previews must never flash internal syntax: strip complete command
    // tags plus any trailing "<<" fragment the model may be mid-emit. A lone "<"
    // can't parse as a tag, so it can wait for the next chunk.
    _stripPartialTags(text) {
        return String(text ?? '')
            .replace(/<{2,3}\s*(?:RUN_CMD|ACTIONS_INTENDED)\s*:[\s\S]*?>{2,3}/g, '')
            .replace(/<{2,3}\s*(?:RUN_CMD|ACTIONS_INTENDED)\s*:[^<>]*>?\s*$/g, '')
            .replace(/<<[^<>]*$/g, '')
    }
    async _streamChat(messages, model, maxTokens, temp, message, stubHint = null, agent = 'chat') {
        if (!this._groq) return null
        // Route the open through the provider pool when it covers this base:
        // a breaker-open or dead-keyed provider must be skipped instantly,
        // not waited on for 30s. Falls back to the legacy client otherwise.
        const routerP = (this._providers ?? []).find((p) => p.baseUrl === this.llmBaseUrl)
        if (routerP && Date.now() < routerP.state.openUntil)
            return this._groqCallWithFallbacks(messages, model, maxTokens, temp, undefined, agent)
        const streamClient = routerP?.client ?? this._groq
        const payload = { ...this._buildPayload(model, messages, maxTokens, temp), stream: true }
        let placeholder = null
        let stubP = null
        let full = ''
        let lastEdit = 0
        const t0 = Date.now()
        // Edit pace: 1/s. Discord rate-limits message edits aggressively, and
        // sub-second edits 429 silently (swallowed .catch) leaving the stream
        // stalled-looking until the final edit. First chunk still posts
        // immediately (lastEdit starts at 0).
        const editGap = () => 1000
        const MAX_LEN = 1900 // leave room for the streaming cursor glyph
        // Pondering stub adapts to expected effort (passed in by the caller,
        // which knows prompt size and token budget) instead of one dry "…".
        // Short asks stay minimal; long/research-heavy ones narrate the wait.
        const stubText = stubHint ?? (maxTokens > 800 ? 'give me a sec…' : maxTokens > 500 ? 'one sec…' : '…')

        try {
            // Open the stream and post the placeholder in parallel: the stub
            // lands instantly instead of after provider TTFT (9-12s of bare
            // typing), so perceived latency drops to ~zero. stubP is awaited
            // in catch too, or a failed open orphans the "…" in-channel.
            stubP = this.secureReply(message, stubText, { allowedMentions: { parse: [] } }).then((m) => {
                placeholder = m ?? null
                // Stash for the caller: handleAIResponse rewrites this exact
                // message post-parse (confirm UI / footer) and must not pay a
                // REST re-fetch + heuristic match for an object we hold.
                if (message && m) message._medusaStreamMsg = m
                // Discord clears typing client-side the moment WE send. Re-fire
                // immediately so the indicator survives the stub instead of
                // gaping until the next 5s tick. Same after the final edit.
                message.channel?.sendTyping?.().catch(() => {})
                return m
            })
            // Stream-open gets its own 30s ceiling: provider TTFT (notably
            // xkiro) routinely exceeds the shared 12s client default, and a
            // timed-out open kills streaming even when the provider would
            // have answered. Non-stream paths keep 12s + fallbacks.
            const [stream] = await Promise.all([
                streamClient.chat.completions.create(payload, { timeout: 30_000 }),
                stubP,
            ])
            const openMs = Date.now() - t0
            let firstMs = null
            for await (const chunk of stream) {
                const delta = chunk.choices?.[0]?.delta?.content ?? ''
                if (!delta) continue
                if (firstMs === null) {
                    firstMs = Date.now() - t0
                    if (this._config?.debug)
                        console.log(`[AI] Stream open ${openMs}ms, first chunk +${firstMs - openMs}ms`)
                }
                full += delta
                const now = Date.now()
                if (placeholder && now - lastEdit >= editGap() && full.length <= MAX_LEN) {
                    lastEdit = now
                    placeholder.edit(this._stripPartialTags(full) + ' ▌').catch(() => {})
                }
                // No early break past MAX_LEN: edits stop (gate above) but the
                // stream keeps draining, so the caller gets the COMPLETE reply
                // and splitResponse can post the overflow. Breaking here used
                // to silently truncate every reply longer than ~1900 chars
                // (and drop any RUN_CMD tag the model emitted late).
            }
            if (placeholder) {
                const finalText = this.finalSecurityCheck(this._stripPartialTags(full).slice(0, 2000))
                if (finalText.trim()) placeholder.edit(finalText).catch(() => {})
                else placeholder.delete().catch(() => {})
            }
            return full || null
        } catch (e) {
            console.warn('[AI] stream failed, falling back to non-stream:', String(e).slice(0, 160))
            // Feed the failure back into routing state so the next turn doesn't
            // repeat it: rotate on key errors, trip the breaker otherwise
            // (request errors like 400/404 are the caller's fault, not the key's).
            if (routerP) {
                if (this._isKeyError(e))
                    this._rotateProviderKey(routerP, this._parseRetryMs(e), 'stream open', e)
                else if (!this._isRequestError(e)) this._tripBreaker(routerP, e)
            }
            try {
                const s = stubP ? await stubP : placeholder
                await s?.delete?.().catch(() => {})
                // Don't let the caller resurrect it: the streamed branch would
                // otherwise edit a deleted message (harmless 404, still noise).
                if (message) message._medusaStreamMsg = null
            } catch {}
            // The stream open already spent up to 30s of the user's patience;
            // hand the fallback chain a SHORT shared budget seeded with this
            // base as dead (timeout/5xx = provider-side, not our payload), so
            // the chain skips straight to a healthy provider instead of
            // re-hitting the corpse for another 25s inside a fresh 30s budget.
            const budget = {
                until: Date.now() + 15_000,
                dead: new Set(this._isKeyError(e) || this._isRequestError(e) ? [] : [this.llmBaseUrl]),
            }
            return this._groqCallWithFallbacks(messages, model, maxTokens, temp, undefined, agent, budget)
        }
    }

    // Ad-hoc client for a fallback entry (own provider + first key). Reuses the
    // router provider's live client when the baseUrl matches, so breaker state
    // and key rotation stay shared instead of split-brained.
    _fallbackClient(entry) {
        if (!entry?.baseUrl || !entry?.keys?.length) return null
        const hit = (this._providers ?? []).find((p) => p.baseUrl === entry.baseUrl && p.client)
        if (hit) return hit.client
        this._fallbackClients ??= new Map()
        const id = `${entry.baseUrl}|${entry.keys[0]}`
        if (!this._fallbackClients.has(id)) {
            try {
                this._fallbackClients.set(
                    id,
                    new OpenAI({
                        apiKey: entry.keys[0],
                        baseURL: entry.baseUrl,
                        timeout: 12_000,
                        maxRetries: 0,
                    }),
                )
            } catch {
                return null
            }
        }
        return this._fallbackClients.get(id) ?? null
    }

    // One attempt at one fallback entry. Never throws, never rotates keys:
    // failure just means "next entry". Breaker-open router providers are
    // skipped fast without burning a call.
    async _tryFallbackEntry(entry, messages, maxTokens, temp, topP, budget = null) {
        if (!entry?.baseUrl || !entry?.keys?.length || !entry?.model) return null
        if (budget && Date.now() > budget.until) return null
        if (budget?.dead.has(entry.baseUrl)) return null
        if (budget?.tried?.has(`${entry.baseUrl}|${entry.model}`)) return null
        budget?.tried?.add(`${entry.baseUrl}|${entry.model}`)
        const routerP = (this._providers ?? []).find((p) => p.baseUrl === entry.baseUrl)
        if (routerP && Date.now() < (routerP.state.openUntil ?? 0)) return null
        const client = routerP?.client ?? this._fallbackClient(entry)
        if (!client) return null
        try {
            const payload = this._buildPayload(entry.model, messages, maxTokens, temp, topP, entry.baseUrl)
            // Same hard-cap rule as _routedCall: an attempt that starts inside
            // the budget must not outlive it by the full 12s client default.
            const opts = budget
                ? { timeout: Math.max(1000, Math.min(12_000, budget.until - Date.now())) }
                : undefined
            const r = await client.chat.completions.create({ ...payload, stream: false }, opts)
            const out = r.choices?.[0]?.message?.content
            if (out) {
                if (routerP) this._resetBreaker(routerP)
                return out
            }
            return null
        } catch (e) {
            if (this._isBillingError(e) && routerP) {
                routerP.state.openUntil = Date.now() + 5 * 60_000
                routerP.state.failures = 0
                console.warn(`[AI] Fallback provider '${routerP.name}' billing-blocked, skipping`)
            } else if (budget) {
                const st = this._errorStatus(e)
                if (st == null || st >= 500) budget.dead.add(entry.baseUrl)
            }
            return null
        }
    }

    async _groqCallWithFallbacks(
        messages,
        model,
        maxTokens = 2500,
        temp = this.temperature,
        topP,
        agent = 'chat',
        budgetIn = null,
    ) {
        // Single-provider installs skip the router; multi-provider installs
        // route first and walk the chain on miss. The old code always ran
        // _groqCall after _routedCall, re-hitting the same provider/model the
        // router just tried (duplicate hop + up to 12s burn, breaker ignored).
        // _groqCall stays for the single-provider case only.
        const budget = budgetIn ?? {
            until: Date.now() + (this._replyBudgetMs ?? 30_000),
            dead: new Set(),
            tried: new Set(),
        }
        budget.tried ??= new Set()
        // Route toward the requesting agent's own provider when it has one
        // (quickAgent on xkiro must not open on groq just because chat lives
        // there); otherwise the chat base stays preferred.
        const agentBase = this._config?.agents?.[agent]?.resolved?.baseUrl ?? this.llmBaseUrl
        if (this._providers?.length > 1) {
            const routed = await this._routedCall(messages, model, maxTokens, temp, topP, budget, agentBase)
            if (routed) return routed
            // The legacy client lives on the chat base: only worth one hop
            // when this agent shares it, otherwise it re-fires a pair the
            // router (or the agent chain below) already covers.
            if (agentBase === this.llmBaseUrl && !budget.tried.has(`${this.llmBaseUrl}|${model}`)) {
                budget.tried.add(`${this.llmBaseUrl}|${model}`)
                const legacy = await this._groqCall(messages, model, maxTokens, temp, topP)
                if (legacy && !legacy.capacityError) return legacy
            }
        } else {
            const result = await this._groqCall(messages, model, maxTokens, temp, topP)
            if (result && !result.capacityError) return result
        }
        for (const fb of this.agentFallbacks?.[agent] ?? []) {
            if (Date.now() > budget.until) break
            const out = await this._tryFallbackEntry(fb, messages, maxTokens, temp, topP, budget)
            if (out) return out
        }
        return null
    }
}
