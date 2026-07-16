// Performance tuning loader.
// Reads configs/performance.json; merges with defaults.
// Missing file is fine, defaults apply.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'

const PERF_PATH = 'configs/performance.json'

// One-time move from the old repo-root location.
try {
    mkdirSync('configs', { recursive: true })
    if (existsSync('performance.json') && !existsSync(PERF_PATH)) renameSync('performance.json', PERF_PATH)
} catch {}

// Hard defaults, match the project's original tuning for a 256MB/shared-host budget.
const DEFAULTS = {
    node: {
        uvThreadpoolSize: null,
        maxOldSpaceSizeMB: null,
        maxSemiSpaceSizeMB: null,
    },
    sqlite: {
        cacheSizeKB: 20000,
        mmapSizeBytes: 67108864,
        journalSizeLimit: 4096000,
        walAutocheckpoint: 5000,
    },
    discord: {
        messageCache: 100,
        memberCacheMax: 200,
        userCache: null,
        messageSweepInterval: 300,
        messageSweepLifetime: 900,
    },
    ai: {
        responseCacheMax: 512,
        responseCacheTTLSec: 300,
        responseCacheMaxMB: 20,
        userCacheMax: 500,
        userCacheTTLSec: 120,
        messageHistoryMax: 200,
        messageHistoryTTLMin: 30,
        repliedMsgCacheMax: 500,
        repliedMsgCacheTTLMin: 10,
        memoryDepth: 25,
        passiveBufferMax: 25,
        passiveBufferChannelsMax: 500,
    },
    maintenance: {
        cleanupIntervalMin: 10,
        retentionDays: 30,
        vacuumEveryDays: 7,
        loopLagWarnMs: 500,
    },
}

function deepMerge(base, override) {
    if (!override || typeof override !== 'object') return base
    const out = { ...base }
    for (const [k, v] of Object.entries(override)) {
        if (v === null || v === undefined) continue
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            out[k] = deepMerge(base[k] ?? {}, v)
        } else {
            out[k] = v
        }
    }
    return out
}

let _cached = null
export function loadPerformance() {
    if (_cached) return _cached
    if (!existsSync(PERF_PATH)) {
        // Write example + default file so first-time users see the knobs
        try {
            writeFileSync(PERF_PATH, JSON.stringify(DEFAULTS, null, 2))
            console.log('[Perf] Created default performance.json, edit to tune')
        } catch (e) {
            console.warn('[Perf] Could not create performance.json:', e.message)
        }
        _cached = DEFAULTS
        return _cached
    }
    try {
        const raw = readFileSync(PERF_PATH, 'utf8')
        const user = JSON.parse(raw)
        _cached = deepMerge(DEFAULTS, user)
        // Advise on Node flag mismatches (can't change them at runtime)
        const n = _cached.node ?? {}
        if (n.uvThreadpoolSize && process.env.UV_THREADPOOL_SIZE !== String(n.uvThreadpoolSize)) {
            console.warn(`[Perf] performance.json wants UV_THREADPOOL_SIZE=${n.uvThreadpoolSize} but process has ${process.env.UV_THREADPOOL_SIZE || 'default(4)'}, set via npm script or env`)
        }
        if (n.maxOldSpaceSizeMB) {
            const cur = process.execArgv.join(' ') + ' ' + (process.env.NODE_OPTIONS || '')
            if (!cur.includes('--max-old-space-size')) {
                console.warn(`[Perf] performance.json wants --max-old-space-size=${n.maxOldSpaceSizeMB}MB but it's not set, start with NODE_OPTIONS or npm script`)
            }
        }
        console.log('[Perf] Loaded performance.json')
        return _cached
    } catch (e) {
        console.warn('[Perf] performance.json parse error, using defaults:', e.message)
        _cached = DEFAULTS
        return _cached
    }
}

export function getPerf() { return _cached ?? loadPerformance() }
