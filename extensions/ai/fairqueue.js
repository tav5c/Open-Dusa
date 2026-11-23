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
        for (const m of messages ?? []) {
            const content =
                typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')
            h.update(`|${m.role ?? ''}:${content.slice(-2000)}`)
        }
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
        this._usage = new Map() // guildId -> { entries: [{t, tokens}], head: 0, tokenSum: 0, lastT: 0 }
        this._inflight = 0
        this._queues = new Map() // guildId -> { items: [waiter], head: 0 }
        this._queueOrder = [] // round-robin rotation of guildIds with waiters
        this._orderHead = 0
        this._queuedGuilds = new Set() // O(1) membership for _queueOrder
        this._pending = new Map() // payloadKey -> Promise (coalescing)
        this._shedAt = new Map() // guildId -> ts of last shed notice
        this._throttleLoggedAt = new Map()
    }

    _pruneTimestampMap(map, ttlMs, maxSize, now) {
        if (map.size <= maxSize) return
        for (const [k, ts] of map) {
            if (now - ts >= ttlMs) map.delete(k)
        }
        while (map.size > maxSize) {
            const oldest = map.keys().next().value
            map.delete(oldest)
        }
    }

    _logThrottled(guildId, detail) {
        const now = Date.now()
        if (now - (this._throttleLoggedAt.get(guildId) ?? 0) < THROTTLE_LOG_MS) return
        this._throttleLoggedAt.set(guildId, now)
        this._pruneTimestampMap(this._throttleLoggedAt, THROTTLE_LOG_MS, 500, now)
        console.warn(`[AI] Guild ${guildId} over fair-share budget, shedding (${detail})`)
    }

    _prune(guildId, now = Date.now()) {
        const bucket = this._usage.get(guildId)
        if (!bucket) return { count: 0, tokenSum: 0 }
        const { entries } = bucket
        while (bucket.head < entries.length && now - entries[bucket.head].t >= WINDOW_MS) {
            bucket.tokenSum -= entries[bucket.head].tokens
            entries[bucket.head] = undefined
            bucket.head++
        }
        const count = entries.length - bucket.head
        if (count <= 0) {
            this._usage.delete(guildId)
            return { count: 0, tokenSum: 0 }
        }
        if (bucket.tokenSum < 0) bucket.tokenSum = 0
        if (bucket.head > 64 && bucket.head * 2 >= entries.length) {
            bucket.entries = entries.slice(bucket.head)
            bucket.head = 0
        }
        if (this._usage.size > 1000) {
            let stalestKey = null
            let stalestTs = Infinity
            for (const [k, b] of this._usage) {
                if (k === guildId) continue
                if (b.lastT < stalestTs) {
                    stalestTs = b.lastT
                    stalestKey = k
                }
            }
            if (stalestKey !== null) this._usage.delete(stalestKey)
        }
        return { count, tokenSum: bucket.tokenSum }
    }

    _record(guildId, tokens) {
        const now = Date.now()
        let bucket = this._usage.get(guildId)
        if (!bucket) {
            bucket = { entries: [], head: 0, tokenSum: 0, lastT: now }
            this._usage.set(guildId, bucket)
        }
        bucket.entries.push({ t: now, tokens })
        bucket.tokenSum += tokens
        bucket.lastT = now
    }

    shedNoticeOk(guildId) {
        const now = Date.now()
        const gid = guildId ?? 'dm'
        if (now - (this._shedAt.get(gid) ?? 0) < SHED_NOTICE_MS) return false
        this._shedAt.set(gid, now)
        this._pruneTimestampMap(this._shedAt, SHED_NOTICE_MS, 500, now)
        return true
    }

    _dequeueGuild(q) {
        while (q.head < q.items.length) {
            const w = q.items[q.head]
            q.items[q.head] = undefined
            q.head++
            if (w && !w._cancelled) return w
        }
        return null
    }

    _hasActiveWaiters(q) {
        while (q.head < q.items.length) {
            const w = q.items[q.head]
            if (w && !w._cancelled) return true
            q.items[q.head] = undefined
            q.head++
        }
        return false
    }

    _compactOrder() {
        if (this._orderHead >= this._queueOrder.length) {
            this._queueOrder.length = 0
            this._orderHead = 0
        } else if (this._orderHead > 64 && this._orderHead * 2 >= this._queueOrder.length) {
            this._queueOrder = this._queueOrder.slice(this._orderHead)
            this._orderHead = 0
        }
    }

    _pump() {
        while (this._inflight < this.inflightMax && this._orderHead < this._queueOrder.length) {
            const gid = this._queueOrder[this._orderHead]
            this._queueOrder[this._orderHead] = undefined
            this._orderHead++
            this._queuedGuilds.delete(gid)
            const q = this._queues.get(gid)
            if (!q) continue
            const waiter = this._dequeueGuild(q)
            if (!waiter) {
                this._queues.delete(gid)
                continue
            }
            if (this._hasActiveWaiters(q)) {
                if (q.head > 64 && q.head * 2 >= q.items.length) {
                    q.items = q.items.slice(q.head)
                    q.head = 0
                }
                this._queueOrder.push(gid)
                this._queuedGuilds.add(gid)
            } else {
                this._queues.delete(gid)
            }
            this._inflight++
            waiter()
        }
        this._compactOrder()
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
                    () => {
                        if (this._pending.get(coalesceKey) === promise) this._pending.delete(coalesceKey)
                    },
                    () => {
                        if (this._pending.get(coalesceKey) === promise) this._pending.delete(coalesceKey)
                    },
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
        const { count, tokenSum } = this._prune(gid, now)
        if (count >= this.guildCalls || tokenSum + tokens > this.guildTokens) {
            this._logThrottled(gid, `${count} calls/${tokenSum} tokens in 60s`)
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
                Promise.resolve()
                    .then(run)
                    .then(
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
            let waiter
            const timer = setTimeout(() => {
                if (waiter) waiter._cancelled = true
                const q = this._queues.get(gid)
                if (q && !this._hasActiveWaiters(q)) {
                    this._queues.delete(gid)
                    this._queuedGuilds.delete(gid)
                }
                resolve(false)
            }, QUEUE_WAIT_MS)
            waiter = () => {
                clearTimeout(timer)
                resolve(true)
            }
            waiter._cancelled = false
            let q = this._queues.get(gid)
            if (!q) {
                q = { items: [], head: 0 }
                this._queues.set(gid, q)
            }
            q.items.push(waiter)
            if (!this._queuedGuilds.has(gid)) {
                this._queuedGuilds.add(gid)
                this._queueOrder.push(gid)
            }
            this._pump()
        })
        if (!waited) {
            this._logThrottled(gid, `queue wait > ${QUEUE_WAIT_MS / 1000}s`)
            return { ok: false, reason: 'queue-timeout' }
        }
        // Re-check coalescing after waking from queue to avoid duplicate flights.
        if (coalesceKey) {
            const ex = this._pending.get(coalesceKey)
            if (ex) {
                this._release()
                return { ok: true, shared: ex }
            }
        }
        // Re-check budget after the wait: the guild may have burned it meanwhile.
        const { count: count2, tokenSum: used2 } = this._prune(gid)
        if (count2 >= this.guildCalls || used2 + tokens > this.guildTokens) {
            this._release()
            return { ok: false, reason: 'guild-budget' }
        }
        return finish()
    }

    static keyFor = payloadKey
}
