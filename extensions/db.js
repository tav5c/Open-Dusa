// extensions/db.js
// Encrypted-at-rest SQLite loader (SQLCipher via better-sqlite3-multiple-ciphers)
// with transparent, one-time migration of existing plaintext databases.
//
// Enable by setting the DB_ENCRYPTION_KEY environment variable (e.g. in your
// Pterodactyl "Startup" variables). If it is unset, the bot falls back to
// plaintext storage so existing self-hosters are unaffected.

import { existsSync, renameSync, unlinkSync } from 'fs'

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
    return { Database: _Database, isCipher: _isCipher }
}

export function encryptionEnabled() {
    return _isCipher && !!(process.env.DB_ENCRYPTION_KEY || '')
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
    const key = process.env.DB_ENCRYPTION_KEY || ''

    // No key, or a driver without cipher support -> plain open (backward compatible).
    if (!key || !_isCipher) {
        return new _Database(path)
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
        // Encryption isn't usable on this host, almost always because the native build
        // of better-sqlite3-multiple-ciphers didn't run its install scripts (Pterodactyl
        // and similar hosts block them by default), so `sqlcipher_export` isn't registered.
        // A failed migration must NEVER take the whole DB down: close the temp attempt,
        // leave the original plaintext file untouched, and return a real PLAINTEXT handle
        // so persistence keeps working. The key is effectively ignored until the host can
        // build the cipher module.
        try {
            plain.close()
        } catch {}
        try {
            if (existsSync(tmp)) unlinkSync(tmp)
        } catch {}
        console.warn(
            `[DB] At-rest encryption unavailable (${e.message}). Running UNENCRYPTED on ${path}, ` +
                `your data is intact and the bot is fully functional, but DB_ENCRYPTION_KEY is being ignored. ` +
                `To enable encryption, allow native install scripts (e.g. npm approve-scripts better-sqlite3-multiple-ciphers) so the cipher module builds, then restart.`,
        )
        return new _Database(path)
    }

    // Swap plaintext -> encrypted, keeping a one-time backup of the original.
    renameSync(path, `${path}.plain-bak`)
    _rmSidecars(path)
    renameSync(tmp, path)
    console.log(
        `[DB] Encrypted ${path} at rest (SQLCipher). Plaintext backup saved as ${path}.plain-bak, ` +
            `delete it once you've confirmed the bot works.`,
    )

    const conn = new _Database(path)
    conn.pragma(`key = '${_quote(key)}'`)
    return conn
}
