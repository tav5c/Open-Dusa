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

        this.monitor      = { mem: 0, heap: 0, cpu: 0, last: 0, peakMem: 0, loopLag: 0, diskUsed: 0, diskTotal: 0, uptime: 0 }
        this._latency     =[]
        this.wsLatencyAvg = 0
        this.wsLatencySpike = false
        this._memHistory  = []

        this.loopHistogram = monitorEventLoopDelay({ resolution: 20 })
        this.loopHistogram.enable()

        this._startMonitor()
        this._startCleanup()
        this._registerExitHandlers()
    }

    fire(promise, name = 'task', timeout = 300_000) {
        this._stats.firedTasks++
        let p = (promise instanceof Promise ? promise : Promise.resolve().then(promise))
            .catch(e => console.error(`[Heart] Task '${name}' error:`, e))
        
        // auto-expunge hung tasks so they don't leak in the set forever
        // timeout <= 0 means daemon loop — never expire
        const timer = timeout > 0 ? setTimeout(() => {
            console.warn(`[Heart] Task '${name}' timed out after ${timeout}ms — forcing cleanup`)
            this._tasks.delete(p)
        }, timeout).unref() : null
        
        p.finally(() => {
            if (timer) clearTimeout(timer)
            this._tasks.delete(p)
        })
        this._tasks.add(p)
        return p
    }

    recordLatency(ms) {
        this._latency.push(ms)
        if (this._latency.length > 30) this._latency.shift()
        this.wsLatencyAvg   = this._latency.reduce((a, b) => a + b, 0) / this._latency.length
        this.wsLatencySpike = ms > this.wsLatencyAvg * 3
    }

    _startMonitor() {
        let histResetCount = 0
        const tick = async () => {
            if (this._closed) return
            const mem = process.memoryUsage()
            const mb  = mem.rss / 1024 / 1024
            const heapMb = mem.heapUsed / 1024 / 1024
            this.monitor.mem     = mb
            this.monitor.heap    = heapMb
            this.monitor.peakMem = Math.max(this.monitor.peakMem, mb)
            this.monitor.last    = Date.now()
            this.monitor.uptime  = Math.floor(process.uptime())

            this._memHistory.push({ ts: Date.now(), rss: mb })
            if (this._memHistory.length > 30) this._memHistory.shift()
            if (this._memHistory.length >= 10) {
                const first = this._memHistory[0]
                const last  = this._memHistory[this._memHistory.length - 1]
                const mins  = (last.ts - first.ts) / 60000
                if (mins > 2) {
                    const growth = (last.rss - first.rss) / mins
                    if (growth > 30 && mb > 400) {
                        console.warn(`[Heart] MEMORY LEAK: RSS +${growth.toFixed(1)}MB/min (now ${mb.toFixed(0)}MB)`)
                    }
                }
            }

            // Reset event loop histogram every 5 min so mean stays relevant
            histResetCount++
            if (histResetCount >= 30) {
                histResetCount = 0
                try { this.loopHistogram.disable() } catch {}
                this.loopHistogram = monitorEventLoopDelay({ resolution: 20 })
                this.loopHistogram.enable()
            }
            this.monitor.loopLag = this.loopHistogram.mean / 1e6
            if (this.monitor.loopLag > 500) {
                console.warn(`[Heart] EVENT LOOP LAG: ${this.monitor.loopLag.toFixed(0)}ms — possible blocking operation`)
            }

            // Disk check (critical for Pterodactyl/ephemeral hosts)
            try {
                const fsData = await si.fsSize()
                const main = fsData?.find(f => f.fs === '/' || f.mount === '/') || fsData?.[0]
                if (main) {
                    this.monitor.diskUsed  = main.used / 1024 / 1024 / 1024
                    this.monitor.diskTotal = main.size / 1024 / 1024 / 1024
                    if (main.use > 90) console.warn(`[Heart] DISK ALMOST FULL: ${main.use.toFixed(0)}%`)
                }
            } catch { /* fsSize fails in some containers — ignore */ }

            // CPU: prefer systeminformation, fallback to last-known (non-blocking)
            try {
                const load = await si.currentLoad()
                this.monitor.cpu = load.currentLoad ?? 0
            } catch {
                // Container/restricted env: keep last known, don't block 100ms
                this.monitor.cpu = this.monitor.cpu || 0
            }

            if (this.client?.ws) {
                const ping = this.client.ws.ping
                if (ping >= 0) this.recordLatency(ping)
            }
        }
        tick()
        this._monitorInterval = setInterval(tick, 10_000).unref()
    }

    _startCleanup() {
        this._cleanupInterval = setInterval(() => {
            this.rateLimiter.cleanup()
            // Prune dead guilds from heart cache to prevent memory leak on server leaves
            const now = Date.now()
            for (const [gid, data] of this.guildCache) {
                if (data.lastAccess && now - data.lastAccess > 7 * 86400000) {
                    this.guildCache.delete(gid)
                }
            }
            for (const [gid, data] of this.automodCache) {
                if (data.lastAccess && now - data.lastAccess > 7 * 86400000) {
                    this.automodCache.delete(gid)
                }
            }
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
        process.once('SIGINT',  () => shutdown('SIGINT').then(() => { process.exitCode = 0 }))
        process.once('SIGTERM', () => shutdown('SIGTERM').then(() => { process.exitCode = 0 }))
        process.on('uncaughtException', e => { 
            console.error('[Heart] FATAL Uncaught:', e)
            // Allow async cleanup (DB flush, WAL checkpoint) before exit
            process.exitCode = 1
            setTimeout(() => process.exit(1), 2000).unref()
        })
        process.on('unhandledRejection', (r) => { console.error('[Heart] Unhandled rejection:', r); this._stats.errors++ })
    }

    close() {
        this._closed = true
        clearInterval(this._monitorInterval)
        clearInterval(this._cleanupInterval)
        if (this.loopHistogram) {
            try { this.loopHistogram.disable() } catch {}
            this.loopHistogram = null
        }
    }
}

export function attachHeart(client) {
    const heart = new MedusaHeart(client)
    client.heart = heart
    return heart
}
