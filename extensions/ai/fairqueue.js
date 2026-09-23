// Fair-share gate for the shared provider pool (Groq TPM is per key, but a
// flood burns every key into cooldown at once and starves other guilds).
// In-process only: single Node process, no Redis on this tier.
//
// Three mechanisms, all generous — normal traffic never notices:
//   1. Per-guild sliding-log bucket (calls + estimated tokens per 60s).
//   2. Global in-flight cap with per-guild FIFO queues (round-robin drain).
//   3. In-flight coalescing: identical concurrent payloads share one call.
// Priority (owner / DM / mod-action) skips bucket+queue but still counts
// usage, so admin commands never queue behind a spam flood.
import { createHash } from 'crypto'

const WINDOW_MS = 60_000
const GUILD_MAX_CALLS = 40
const GUILD_MAX_TOKENS = 150_000
// 8 concurrent provider calls: high enough that a busy server never queues
// behind it (queueing under an 11s TTFT is felt instantly), low enough that
// a burst can't cooler-burn all 18 keys at once. Per-guild buckets remain
// the real flood control; this cap is burst plumbing, not policy.
const GLOBAL_INFLIGHT_MAX = 8
const QUEUE_WAIT_MS = 30_000
const SHED_NOTICE_MS = 60_000
const THROTTLE_LOG_MS = 5 * 60_000

export const estTokens = (promptChars = 0, maxTokens = 0, images = 0) =>
    Math.ceil((promptChars || 0) / 4) + (maxTokens || 0) + (images || 0) * 1500

const payloadKey = (model, messages) => {
    try {
        const h = createHash('md5')
        h.update(String(model ?? ''))
        for (const m of messages ?? []) h.update(`|${m.role ?? ''}:${String(m.content ?? '').slice(-2000)}`)
        return h.digest('hex')
    } catch {
        return null
    }
}

export class FairQueue {
    constructor(overrides = {}) {
        this.guildCalls = GUILD_MAX_CALLS
        this.guildTokens = GUILD_MAX_TOKENS
        this.inflightMax = GLOBAL_INFLIGHT_MAX
        Object.assign(this, overrides)
        this._usage = new Map() // guildId -> [{t, tokens}]
        this._inflight = 0
        this._queues = new Map() // guildId -> [{resolve}]
        this._queueOrder = [] // round-robin rotation of guildIds with waiters
        this._pending = new Map() // payloadKey -> Promise (coalescing)
        this._shedAt = new Map() // guildId -> ts of last shed notice
        this._throttleLoggedAt = new Map()
    }

    _logThrottled(guildId, detail) {
        const now = Date.now()
        if (now - (this._throttleLoggedAt.get(guildId) ?? 0) < THROTTLE_LOG_MS) return
        this._throttleLoggedAt.set(guildId, now)
        console.warn(`[AI] Guild ${guildId} over fair-share budget, shedding (${detail})`)
    }

    _prune(guildId, now = Date.now()) {
        const log = this._usage.get(guildId)
        if (!log) return []
        const fresh = log.filter((e) => now - e.t < WINDOW_MS)
        if (fresh.length) this._usage.set(guildId, fresh)
        else this._usage.delete(guildId)
        if (this._usage.size > 1000) {
            const oldest = this._usage.keys().next().value
            this._usage.delete(oldest)
        }
        return fresh
    }

    _record(guildId, tokens) {
        const log = this._usage.get(guildId) ?? []
        log.push({ t: Date.now(), tokens })
        this._usage.set(guildId, log)
    }

    shedNoticeOk(guildId) {
        const now = Date.now()
        if (now - (this._shedAt.get(guildId ?? 'dm') ?? 0) < SHED_NOTICE_MS) return false
        this._shedAt.set(guildId ?? 'dm', now)
        return true
    }

    _pump() {
        while (this._inflight < this.inflightMax && this._queueOrder.length) {
            const gid = this._queueOrder.shift()
            const q = this._queues.get(gid)
            if (!q?.length) {
                this._queues.delete(gid)
                continue
            }
            const waiter = q.shift()
            if (!q.length) this._queues.delete(gid)
            else this._queueOrder.push(gid) // still has waiters, rejoin rotation
            this._inflight++
            waiter()
        }
    }

    _release() {
        this._inflight = Math.max(0, this._inflight - 1)
        this._pump()
    }

    /**
     * @returns {ok:true, release?, shared?} | {ok:false, reason}
     * Slot mode (no run): caller MUST call release() exactly once on ok.
     * Factory mode (coalesceKey + run): identical concurrent payloads share
     * one flight. Registration is synchronous, so same-tick duplicates can't
     * slip past. Caller awaits shared and never releases (gate owns it).
     */
    async acquire({ guildId = 'dm', tokens = 0, priority = false, coalesceKey = null, run = null } = {}) {
        const gid = String(guildId ?? 'dm')
        if (priority) {
            this._record(gid, tokens)
            if (coalesceKey && run) {
                const ex = this._pending.get(coalesceKey)
                if (ex) return { ok: true, shared: ex }
                const promise = Promise.resolve().then(run)
                this._pending.set(coalesceKey, promise)
                promise.then(
                    () => this._pending.delete(coalesceKey),
                    () => this._pending.delete(coalesceKey),
                )
                return { ok: true, shared: promise }
            }
            return { ok: true, release: () => {} }
        }
        if (coalesceKey) {
            const ex = this._pending.get(coalesceKey)
            if (ex) return { ok: true, shared: ex }
        }
        const now = Date.now()
        const log = this._prune(gid, now)
        const usedTokens = log.reduce((a, e) => a + e.tokens, 0)
        if (log.length >= this.guildCalls || usedTokens + tokens > this.guildTokens) {
            this._logThrottled(gid, `${log.length} calls/${usedTokens} tokens in 60s`)
            return { ok: false, reason: 'guild-budget' }
        }
        const takeSlot = () => {
            this._record(gid, tokens)
            let released = false
            return {
                ok: true,
                release: () => {
                    if (released) return
                    released = true
                    this._release()
                },
            }
        }
        // Factory finish: register the shared flight synchronously the moment
        // the slot is ours, so same-tick duplicates can't slip past.
        const finish = () => {
            const slot = takeSlot()
            if (coalesceKey && run) {
                let resolve, reject
                const promise = new Promise((res, rej) => {
                    resolve = res
                    reject = rej
                })
                this._pending.set(coalesceKey, promise)
                run().then(
                    (v) => {
                        if (this._pending.get(coalesceKey) === promise) this._pending.delete(coalesceKey)
                        slot.release()
                        resolve(v)
                    },
                    (e) => {
                        if (this._pending.get(coalesceKey) === promise) this._pending.delete(coalesceKey)
                        slot.release()
                        reject(e)
                    },
                )
                return { ok: true, shared: promise }
            }
            return slot
        }
        if (this._inflight < this.inflightMax) {
            this._inflight++
            return finish()
        }
        // Global cap hit: queue per-guild FIFO, shed after QUEUE_WAIT_MS.
        const waited = await new Promise((resolve) => {
            const timer = setTimeout(() => {
                const q = this._queues.get(gid) ?? []
                const i = q.findIndex((w) => w._resolve === resolve)
                if (i >= 0) q.splice(i, 1)
                resolve(false)
            }, QUEUE_WAIT_MS)
            const waiter = () => {
                clearTimeout(timer)
                resolve(true)
            }
            waiter._resolve = resolve
            const q = this._queues.get(gid) ?? []
            q.push(waiter)
            this._queues.set(gid, q)
            if (!this._queueOrder.includes(gid)) this._queueOrder.push(gid)
            this._pump()
        })
        if (!waited) {
            this._logThrottled(gid, `queue wait > ${QUEUE_WAIT_MS / 1000}s`)
            return { ok: false, reason: 'queue-timeout' }
        }
        // Re-check budget after the wait: the guild may have burned it meanwhile.
        const log2 = this._prune(gid)
        const used2 = log2.reduce((a, e) => a + e.tokens, 0)
        if (log2.length >= this.guildCalls || used2 + tokens > this.guildTokens) {
            this._release()
            return { ok: false, reason: 'guild-budget' }
        }
        return finish()
    }

    static keyFor = payloadKey
}
