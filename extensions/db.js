// extensions/db.js
// Encrypted-at-rest SQLite loader (SQLCipher via better-sqlite3-multiple-ciphers)
// with transparent, one-time migration of existing plaintext databases.
//
// Enable by setting the DB_ENCRYPTION_KEY environment variable (e.g. in your
// Pterodactyl "Startup" variables). If it is unset, the bot falls back to
// plaintext storage so existing self-hosters are unaffected.

import { copyFileSync, existsSync, renameSync, unlinkSync } from 'fs'

let _Database = null
let _isCipher = false

export async function loadSqlite() {
    if (!_Database) {
        try {
            const mod = await import('better-sqlite3-multiple-ciphers')
            _Database = mod.default ?? mod
            _isCipher = true
        } catch (e) {
            console.warn(
                '[DB] better-sqlite3-multiple-ciphers unavailable, falling back to better-sqlite3 with NO at-rest encryption:',
                e.message,
            )
            const mod = await import('better-sqlite3')
            _Database = mod.default ?? mod
            _isCipher = false
        }
    }
    // Expose for modules that resolve the driver lazily via globalThis.
    globalThis._sqlite3 = { default: _Database }
    globalThis._openDb = openDb
    // Probe ONCE whether the native bindings actually work. The JS wrapper can
    // import fine while the .node binary was never built (Pterodactyl and similar
    // hosts block install scripts by default) — every `new Database()` then throws.
    // Marking it here lets every consumer degrade to no-persistence stubs instead
    // of one failed open taking down the whole AI extension.
    try {
        const probe = new _Database(':memory:')
        probe.close?.()
        globalThis._sqliteUsable = true
    } catch (e) {
        globalThis._sqliteUsable = false
        console.warn(
            '[DB] SQLite native bindings missing (install scripts blocked?). Persistence DISABLED — the bot will run memory-less. ' +
                'Fix: `npm install-scripts approve better-sqlite3 better-sqlite3-multiple-ciphers && npm rebuild better-sqlite3 better-sqlite3-multiple-ciphers`, then restart. ' +
                `(${String(e.message).slice(0, 120)})`,
        )
    }
    return { Database: _Database, isCipher: _isCipher }
}

export function sqliteUsable() {
    return globalThis._sqliteUsable !== false && !!_Database
}

function _quote(s) {
    return String(s).replace(/'/g, "''")
}

function _rmSidecars(path) {
    for (const suffix of ['-wal', '-shm']) {
        try {
            if (existsSync(path + suffix)) unlinkSync(path + suffix)
        } catch {}
    }
}

// Opens an (optionally) encrypted database. Transparently migrates an existing
// PLAINTEXT database to encrypted on first run once a key is configured.
export function openDb(path) {
    if (!_Database) throw new Error('[DB] loadSqlite() must be awaited before openDb()')
    // Short here on purpose: the full fix line already printed once at probe
    // time (above). Repeating the install command per database would spam boot.
    if (globalThis._sqliteUsable === false)
        throw new Error('[DB] SQLite engine unavailable (bindings missing — see startup warning).')
    const key = process.env.DB_ENCRYPTION_KEY || ''

    // No key -> plain open (backward compatible).
    if (!key) {
        return new _Database(path)
    }

    // Key is configured, but cipher driver is unavailable -> fail closed.
    if (!_isCipher) {
        throw new Error(
            `[DB] DB_ENCRYPTION_KEY is set, but better-sqlite3-multiple-ciphers is unavailable. ` +
                `Refusing to open ${path} unencrypted.`,
        )
    }

    const fileExists = existsSync(path)

    // Brand-new database -> encrypted from the very first byte.
    if (!fileExists) {
        const conn = new _Database(path)
        conn.pragma(`key = '${_quote(key)}'`)
        return conn
    }

    // Existing database -> try to open it as already-encrypted with this key.
    let probe
    try {
        probe = new _Database(path)
        probe.pragma(`key = '${_quote(key)}'`)
        probe.prepare('SELECT count(*) FROM sqlite_master').get() // probe
        return probe
    } catch {
        // Probe failed -> most likely a legacy plaintext DB. Close the probe handle -
        // leaking it keeps the file open and can contribute to "database is locked" -
        // then migrate once below.
        try {
            probe?.close()
        } catch {}
    }

    let plain
    try {
        plain = new _Database(path)
        plain.prepare('SELECT count(*) FROM sqlite_master').get() // confirm it is plaintext
    } catch (e) {
        try {
            plain?.close()
        } catch {}
        throw new Error(
            `[DB] Could not open ${path}: it is neither plaintext nor decryptable with DB_ENCRYPTION_KEY. ` +
                `Check that the key matches the one used to encrypt it. (${e.message})`,
        )
    }

    const tmp = `${path}.enc-tmp`
    try {
        if (existsSync(tmp)) unlinkSync(tmp)
    } catch {}
    try {
        plain.pragma('wal_checkpoint(TRUNCATE)')
    } catch {}
    try {
        plain.exec(`ATTACH DATABASE '${_quote(tmp)}' AS encrypted KEY '${_quote(key)}';`)
        plain.exec(`SELECT sqlcipher_export('encrypted');`)
        plain.exec(`DETACH DATABASE encrypted;`)
        plain.close()
    } catch (e) {
        // Fail closed when DB_ENCRYPTION_KEY is set: never silently fall back
        // to plaintext storage if encryption migration fails.
        try {
            plain.close()
        } catch {}
        try {
            if (existsSync(tmp)) unlinkSync(tmp)
        } catch {}
        throw new Error(
            `[DB] At-rest encryption migration failed for ${path} (${e.message}). ` +
                `Refusing to fall back to unencrypted storage while DB_ENCRYPTION_KEY is set. ` +
                `Ensure better-sqlite3-multiple-ciphers native bindings are built, then restart.`,
        )
    }

    // Verify the encrypted temp copy before touching the original DB.
    let verify
    try {
        verify = new _Database(tmp)
        verify.pragma(`key = '${_quote(key)}'`)
        verify.prepare('SELECT count(*) FROM sqlite_master').get()
        verify.close()
    } catch (e) {
        try {
            verify?.close()
        } catch {}
        try {
            if (existsSync(tmp)) unlinkSync(tmp)
        } catch {}
        throw new Error(
            `[DB] Encrypted migration verification failed for ${path} (${e.message}). Original plaintext file preserved.`,
        )
    }

    // Hardened atomic swap: copy plaintext backup first, then atomically
    // replace `path` with `tmp` so a crash mid-swap never leaves `path` missing.
    const bak = `${path}.plain-bak`
    try {
        copyFileSync(path, bak)
        _rmSidecars(path)
        renameSync(tmp, path)
    } catch (e) {
        try {
            if (!existsSync(path) && existsSync(bak)) copyFileSync(bak, path)
        } catch {}
        try {
            if (existsSync(tmp)) unlinkSync(tmp)
        } catch {}
        throw new Error(`[DB] Failed to swap encrypted database into ${path}: ${e.message}`)
    }
    console.log(
        `[DB] Encrypted ${path} at rest (SQLCipher). Plaintext backup saved as ${bak}, ` +
            `delete it once you've confirmed the bot works.`,
    )

    const conn = new _Database(path)
    conn.pragma(`key = '${_quote(key)}'`)
    return conn
}
