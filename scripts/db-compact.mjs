#!/usr/bin/env node
// Monthly VACUUM/compaction for Open-Dusa SQLite databases.
// Honors DB_ENCRYPTION_KEY so it can open encrypted (SQLCipher) databases.
import { readdirSync } from 'fs'

let Database
try {
    Database = (await import('better-sqlite3-multiple-ciphers')).default
} catch {
    Database = (await import('better-sqlite3')).default
}

const KEY = process.env.DB_ENCRYPTION_KEY || ''

let aiDbs = []
try {
    aiDbs = readdirSync('Ai Database', { recursive: true })
        .filter((f) => String(f).endsWith('.db'))
        .map((f) => 'Ai Database/' + f)
} catch {}

const targets = ['Logs/medusa.db', ...aiDbs]

for (const p of targets) {
    try {
        const d = new Database(p)
        if (KEY) d.pragma(`key='${KEY.replace(/'/g, "''")}'`)
        d.prepare('VACUUM').run()
        d.close()
        console.log('VACUUM', p)
    } catch (e) {
        console.log('SKIP', p, e.message)
    }
}
