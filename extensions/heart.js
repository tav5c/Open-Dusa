import { LRUCache } from 'lru-cache'
import os from 'os'
import { monitorEventLoopDelay } from 'perf_hooks'
import si from 'systeminformation'


class GlobalRateLimiter {
    constructor() {
        this.limit     = 4
        this.window    = 5000
        this.cooldowns = new Map()
        this.violations= new Map()
        this.windows   = new Map()
    }

    check(userId) {
        const now = Date.now()
        if (this.cooldowns.has(userId)) {
            if (now < this.cooldowns.get(userId)) return { ok: false, reason: 'user_cooldown' }
            this.cooldowns.delete(userId)
            this.violations.delete(userId)
        }
        let dq = this.windows.get(userId)
        if (!dq) { dq = []; this.windows.set(userId, dq) }
        while (dq.length && now - dq[0] > this.window) dq.shift()
        if (dq.length >= this.limit) {
            const v = (this.violations.get(userId) || 0) + 1
            this.violations.set(userId, v)
            if (v >= 3) this.cooldowns.set(userId, now + 30_000)
            return { ok: false, reason: 'rate_limited' }
        }
        dq.push(now)
        return { ok: true }
    }

    cleanup() {
        const now = Date.now()
        for (const [k, v] of this.cooldowns) {
            if (now > v) {
                this.cooldowns.delete(k);
                this.violations.delete(k);
            }
        }
        for (const [k, dq] of this.windows) if (!dq.length) this.windows.delete(k)
    }
}

class SmartRetrier {
    constructor(attempts = 3, backoff = 1500, maxDelay = 30_000) {
        this.attempts = attempts
        this.backoff  = backoff
        this.maxDelay = maxDelay
    }

    async retry(fn) {
        let last
        for (let i = 0; i < this.attempts; i++) {
            try { return await fn() } catch (e) {
                last = e
                if (i < this.attempts - 1) {
                    const base   = Math.min(this.maxDelay, this.backoff * (1.5 ** i))
                    const jitter = Math.random() * base * 0.3
                    await new Promise(r => setTimeout(r, base + jitter))
                }
            }
        }
        throw last
    }
}

export class MedusaHeart {
    constructor(client) {
        this.client       = client
        this.startTime    = Date.now()
        this._closed      = false
        this._tasks       = new Set()
        this._stats       = { commands: 0, errors: 0, rateLimited: 0, firedTasks: 0 }

        this.cache = new LRUCache({
    max: 2048,
    ttl: 300_000,
    updateAgeOnGet: false,
    allowStale: false,
    maxSize: 50 * 1024 * 1024,
    sizeCalculation: (value) => typeof value === 'string' ? value.length : 1024,
});
        this.guildCache   = new Map()
        this.automodCache = new Map()

        this.rateLimiter  = new GlobalRateLimiter()
        this.retrier      = new SmartRetrier()

        this.monitor      = { mem: 0, cpu: 0, last: 0, peakMem: 0, loopLag: 0 }
        this._latency     =[]
        this.wsLatencyAvg = 0
        this.wsLatencySpike = false

        this.loopHistogram = monitorEventLoopDelay({ resolution: 20 })
        this.loopHistogram.enable()

        this._startMonitor()
        this._startCleanup()
        this._registerExitHandlers()
    }

    fire(promise, name = 'task') {
        this._stats.firedTasks++
        const p = (promise instanceof Promise ? promise : Promise.resolve().then(promise))
            .catch(e => console.error(`[Heart] Task '${name}' error:`, e))
        this._tasks.add(p)
        p.finally(() => this._tasks.delete(p))
        return p
    }

    recordLatency(ms) {
        this._latency.push(ms)
        if (this._latency.length > 30) this._latency.shift()
        this.wsLatencyAvg   = this._latency.reduce((a, b) => a + b, 0) / this._latency.length
        this.wsLatencySpike = ms > this.wsLatencyAvg * 3
    }

    _startMonitor() {
        const tick = async () => {
            if (this._closed) return
            const mem = process.memoryUsage()
            const mb  = mem.rss / 1024 / 1024
            this.monitor.mem     = mb
            this.monitor.peakMem = Math.max(this.monitor.peakMem, mb)
            this.monitor.last    = Date.now()

            this.monitor.loopLag = this.loopHistogram.mean / 1e6 // Convert nanoseconds to milliseconds
            try {
                const load       = await si.currentLoad()
                this.monitor.cpu = load.currentLoad ?? 0
            } catch {
                const before = os.cpus().map(c => ({ idle: c.times.idle, total: Object.values(c.times).reduce((a, b) => a + b, 0) }))
                await new Promise(r => setTimeout(r, 100))
                const after  = os.cpus().map(c => ({ idle: c.times.idle, total: Object.values(c.times).reduce((a, b) => a + b, 0) }))
                const deltas  = before.map((b, i) => ({ idle: after[i].idle - b.idle, total: after[i].total - b.total }))
                const avgIdle = deltas.reduce((s, d) => s + (d.idle / (d.total || 1)), 0) / deltas.length
                this.monitor.cpu = (1 - avgIdle) * 100
            }

            if (this.client?.ws) {
                this.recordLatency(this.client.ws.ping)
            }
        }
        tick()
        this._monitorInterval = setInterval(tick, 10_000).unref()
    }

    _startCleanup() {
            this._cleanupInterval = setInterval(() => {
            this.rateLimiter.cleanup()
        }, 60_000).unref()
    }

    _registerExitHandlers() {
        const shutdown = async (sig) => {
            if (this._closed) return
            this._closed = true
            console.log(`[Heart] ${sig} — shutting down`)
            if (this.loopHistogram) this.loopHistogram.disable()
            clearInterval(this._monitorInterval)
            clearInterval(this._cleanupInterval)
            if (globalThis._aiMemManagers) {
                for (const mgr of globalThis._aiMemManagers) {
                    if (mgr._flushTimer) {
                        clearTimeout(mgr._flushTimer)
                        mgr._flushTimer = null
                        for (const f of mgr._writeQueue) try { f() } catch {}
                        mgr._writeQueue = []
                    }
                }
            }
            if (this._tasks.size) await Promise.allSettled([...this._tasks])
        }
        process.once('SIGINT',  () => shutdown('SIGINT').then(() => process.exit(0)))
        process.once('SIGTERM', () => shutdown('SIGTERM').then(() => process.exit(0)))
        process.on('uncaughtException', e => { 
        console.error('[Heart] FATAL Uncaught:', e); 
        process.exit(1); })
        process.on('unhandledRejection', (r) => { console.error('[Heart] Unhandled rejection:', r); this._stats.errors++ })
    }

    close() {
        this._closed = true
        clearInterval(this._monitorInterval)
        clearInterval(this._cleanupInterval)
    }
}

export function attachHeart(client) {
    const heart = new MedusaHeart(client)
    client.heart = heart
    return heart
}
