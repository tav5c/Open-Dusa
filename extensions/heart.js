import { statfs } from 'node:fs/promises'
import { cpus, loadavg } from 'os'
import { monitorEventLoopDelay } from 'perf_hooks'
import { loadPerformance } from './performance.js'

const PERF = loadPerformance()
const CPU_CORES = cpus()?.length || 1
const VIOLATION_TTL_MS = 60_000
const SHUTDOWN_TASK_TIMEOUT_MS = 5_000

class GlobalRateLimiter {
    constructor() {
        this.limit = 4
        this.window = 5000
        this.staffLimit = 20 // mods get 5x the budget
        this.staffWindow = 5000
        this.cooldowns = new Map()
        this.violations = new Map()
        this.windows = new Map()
    }

    /**
     * @param {string} userId
     * @param {{ isStaff?: boolean, isOwner?: boolean }} ctx
     */
    check(userId, ctx = {}) {
        if (ctx.isOwner) return { ok: true, bypass: 'owner' }
        const now = Date.now()
        const limit = ctx.isStaff ? this.staffLimit : this.limit
        const window = ctx.isStaff ? this.staffWindow : this.window
        if (this.cooldowns.has(userId)) {
            if (now < this.cooldowns.get(userId)) return { ok: false, reason: 'user_cooldown' }
            this.cooldowns.delete(userId)
            this.violations.delete(userId)
        }
        let dq = this.windows.get(userId)
        if (!dq) {
            dq = []
            this.windows.set(userId, dq)
        }
        while (dq.length && now - dq[0] > window) dq.shift()
        if (dq.length >= limit) {
            if (!ctx.isStaff) {
                const prev = this.violations.get(userId)
                const v = (prev && now - prev.lastAt <= VIOLATION_TTL_MS ? prev.count : 0) + 1
                this.violations.set(userId, { count: v, lastAt: now })
                if (v >= 3) this.cooldowns.set(userId, now + 30_000)
            }
            return { ok: false, reason: 'rate_limited' }
        }
        dq.push(now)
        return { ok: true }
    }

    cleanup() {
        const now = Date.now()
        const maxWindow = Math.max(this.window, this.staffWindow)
        for (const [k, v] of this.cooldowns) {
            if (now > v) {
                this.cooldowns.delete(k)
                this.violations.delete(k)
            }
        }
        for (const [k, v] of this.violations) {
            const lastAt = typeof v === 'object' && v !== null ? v.lastAt : 0
            if (now - lastAt > VIOLATION_TTL_MS && !this.cooldowns.has(k)) {
                this.violations.delete(k)
            }
        }
        for (const [k, dq] of this.windows) {
            while (dq.length && now - dq[0] > maxWindow) dq.shift()
            if (!dq.length) this.windows.delete(k)
        }
    }
}

export class MedusaHeart {
    constructor(client) {
        this.client = client
        this.startTime = Date.now()
        this._closed = false
        this._tasks = new Set()
        this._shutdownCallbacks = []
        this._stats = { commands: 0, errors: 0, rateLimited: 0, firedTasks: 0 }

        this.rateLimiter = new GlobalRateLimiter()

        this.monitor = {
            mem: 0,
            heap: 0,
            cpu: 0,
            last: 0,
            peakMem: 0,
            loopLag: 0,
            diskUsed: 0,
            diskTotal: 0,
            uptime: 0,
        }
        this._latency = []
        this.wsLatencyAvg = 0
        this.wsLatencySpike = false
        this._memHistory = []

        this.loopHistogram = monitorEventLoopDelay({ resolution: 20 })
        this.loopHistogram.enable()

        this._startMonitor()
        this._startCleanup()
        this._registerExitHandlers()
    }

    onShutdown(fn) {
        if (typeof fn === 'function') this._shutdownCallbacks.push(fn)
    }

    fire(promise, name = 'task', timeout = 300_000) {
        this._stats.firedTasks++
        let p = (promise instanceof Promise ? promise : Promise.resolve().then(promise)).catch((e) =>
            console.error(`[Heart] Task '${name}' error:`, e),
        )

        // auto-expunge hung tasks so they don't leak in the set forever
        // timeout <= 0 means daemon loop, never expire
        const timer =
            timeout > 0
                ? setTimeout(() => {
                      console.warn(`[Heart] Task '${name}' timed out after ${timeout}ms, forcing cleanup`)
                      this._tasks.delete(p)
                  }, timeout).unref()
                : null

        p.finally(() => {
            if (timer) clearTimeout(timer)
            this._tasks.delete(p)
        })
        this._tasks.add(p)
        return p
    }

    noteRateLimited() {
        this._stats.rateLimited++
    }

    recordLatency(ms) {
        this._latency.push(ms)
        if (this._latency.length > 30) this._latency.shift()
        this.wsLatencyAvg = this._latency.reduce((a, b) => a + b, 0) / this._latency.length
        this.wsLatencySpike = ms > this.wsLatencyAvg * 3
    }

    _startMonitor() {
        let histResetCount = 0
        const tick = async () => {
            if (this._closed) return
            const mem = process.memoryUsage()
            const mb = mem.rss / 1024 / 1024
            const heapMb = mem.heapUsed / 1024 / 1024
            this.monitor.mem = mb
            this.monitor.heap = heapMb
            this.monitor.peakMem = Math.max(this.monitor.peakMem, mb)
            this.monitor.last = Date.now()
            this.monitor.uptime = Math.floor(process.uptime())

            this._memHistory.push({ ts: Date.now(), rss: mb })
            if (this._memHistory.length > 30) this._memHistory.shift()
            if (this._memHistory.length >= 10) {
                const first = this._memHistory[0]
                const last = this._memHistory[this._memHistory.length - 1]
                const mins = (last.ts - first.ts) / 60000
                if (mins > 2) {
                    const growth = (last.rss - first.rss) / mins
                    if (growth > 30 && mb > 400) {
                        console.warn(
                            `[Heart] MEMORY LEAK: RSS +${growth.toFixed(1)}MB/min (now ${mb.toFixed(0)}MB)`,
                        )
                    }
                }
            }

            // Reset event loop histogram every 5 min so mean stays relevant
            histResetCount++
            if (histResetCount >= 30) {
                histResetCount = 0
                try {
                    this.loopHistogram?.reset()
                } catch {}
            }
            this.monitor.loopLag = (this.loopHistogram?.mean ?? 0) / 1e6
            if (this.monitor.loopLag > PERF.maintenance.loopLagWarnMs) {
                console.warn(
                    `[Heart] EVENT LOOP LAG: ${this.monitor.loopLag.toFixed(0)}ms, possible blocking operation`,
                )
            }

            // Disk check (critical for Pterodactyl/ephemeral hosts). Async
            // statfs: non-blocking, no subprocess, no dependency.
            try {
                const st = await statfs('/')
                const size = st.blocks * st.bsize
                const used = (st.blocks - st.bfree) * st.bsize
                if (size > 0) {
                    this.monitor.diskUsed = used / 1024 / 1024 / 1024
                    this.monitor.diskTotal = size / 1024 / 1024 / 1024
                    const pct = (used / size) * 100
                    if (pct > 90) console.warn(`[Heart] DISK ALMOST FULL: ${pct.toFixed(0)}%`)
                }
            } catch {
                /* statfs fails in some containers, ignore */
            }

            // CPU: 1-min load average as % of capacity. Not identical to a
            // point-in-time reading, but close enough for a warning threshold —
            // and it's a syscall, not a subprocess spawn.
            try {
                this.monitor.cpu = (loadavg()[0] / CPU_CORES) * 100
            } catch {
                // Restricted env: keep last known, don't block
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
        }, 60_000).unref()
    }

    _registerExitHandlers() {
        const shutdown = async (sig) => {
            if (this._closed) return
            this._closed = true
            console.log(`[Heart] ${sig}, shutting down`)
            // Flush pending prefs synchronously first: the 500ms debounced
            // users save would otherwise die with the process on panel stops.
            try {
                this.client?.aiCog?._saveUsersNow?.()
            } catch {}
            if (this.loopHistogram) {
                try {
                    this.loopHistogram.disable()
                } catch {}
            }
            clearInterval(this._monitorInterval)
            clearInterval(this._cleanupInterval)
            if (globalThis._aiMemManagers) {
                for (const mgr of globalThis._aiMemManagers) {
                    if (mgr._flushTimer) {
                        clearTimeout(mgr._flushTimer)
                        mgr._flushTimer = null
                        for (const f of mgr._writeQueue)
                            try {
                                f()
                            } catch {}
                        mgr._writeQueue = []
                    }
                }
            }
            if (this._shutdownCallbacks.length) {
                await Promise.allSettled(
                    this._shutdownCallbacks.map((fn) =>
                        Promise.resolve()
                            .then(() => fn(sig))
                            .catch((e) => console.error('[Heart] Shutdown callback error:', e)),
                    ),
                )
            }
            if (this._tasks.size) {
                let timer
                await Promise.race([
                    Promise.allSettled([...this._tasks]),
                    new Promise((resolve) => {
                        timer = setTimeout(resolve, SHUTDOWN_TASK_TIMEOUT_MS).unref()
                    }),
                ])
                if (timer) clearTimeout(timer)
            }
        }

        this._onSigint = () =>
            shutdown('SIGINT').then(() => {
                process.exitCode = 0
            })
        this._onSigterm = () =>
            shutdown('SIGTERM').then(() => {
                process.exitCode = 0
            })
        this._onUncaughtException = (e) => {
            // Discord API errors bubble up as uncaughts from floating promises.
            // Most are non-fatal (token expired, DM blocked, unknown message), log and continue.
            // Only bail on genuine runtime crashes.
            const code = e?.code
            const isDiscordSoft =
                code === 10008 ||
                code === 10062 ||
                code === 40060 ||
                code === 50001 ||
                code === 50013 ||
                code === 50035 ||
                code === 50007
            if (isDiscordSoft) {
                console.warn(`[Heart] Soft Discord error (${code}), continuing`)
                this._stats.errors++
                return
            }
            console.error('[Heart] FATAL Uncaught:', e)
            process.exitCode = 1
            setTimeout(() => process.exit(1), 2000).unref()
        }
        this._onUnhandledRejection = (r) => {
            console.error('[Heart] Unhandled rejection:', r)
            this._stats.errors++
        }

        process.once('SIGINT', this._onSigint)
        process.once('SIGTERM', this._onSigterm)
        process.on('uncaughtException', this._onUncaughtException)
        process.on('unhandledRejection', this._onUnhandledRejection)
    }

    close() {
        this._closed = true
        clearInterval(this._monitorInterval)
        clearInterval(this._cleanupInterval)
        if (this._onSigint) process.off('SIGINT', this._onSigint)
        if (this._onSigterm) process.off('SIGTERM', this._onSigterm)
        if (this._onUncaughtException) process.off('uncaughtException', this._onUncaughtException)
        if (this._onUnhandledRejection) process.off('unhandledRejection', this._onUnhandledRejection)
        if (this.loopHistogram) {
            try {
                this.loopHistogram.disable()
            } catch {}
            this.loopHistogram = null
        }
    }
}

export function attachHeart(client) {
    const heart = new MedusaHeart(client)
    client.heart = heart
    return heart
}
