// A synthetic production-shaped backup for scripts/backup/recovery-drill.mts tests: the staging seed (demo tenant, scans,
// leads, a stub Gmail connection whose refresh token is encrypted) plus a stored LLM key, all under a fresh master key,
// backed up with the real createBackup. Returns the backup and a mode-600 key file holding that key. No real data.
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export async function fixtureBackup(dir: string, mutate?: (raw: Database.Database, tenant: string) => void): Promise<{ backup: string; keyFile: string; key: string; source: string }> {
  const key = randomBytes(32).toString('base64')
  const prev = { env: process.env.DAZL_ENV, key: process.env.DAZL_MASTER_KEY }
  process.env.DAZL_ENV = 'staging'; process.env.DAZL_MASTER_KEY = key
  try {
    const { seedStaging } = await import('../../scripts/staging-seed.mts')
    const { saveKey } = await import('../../lib/llm/key-store.ts')
    const { createBackup } = await import('../../scripts/backup/lib.ts')
    mkdirSync(path.join(dir, 'live'), { recursive: true })
    const source = path.join(dir, 'live', 'app.db')
    const raw = new Database(source)
    try {
      const { tenant } = await seedStaging(raw, randomBytes(9).toString('hex'))
      saveKey(raw, tenant, 'anthropic', 'sk-ant-api03-recovery-fixture-' + randomBytes(8).toString('hex'), Buffer.from(key, 'base64'))
      mutate?.(raw, tenant)
    } finally { raw.close() }
    const b = await createBackup({ source, destDir: path.join(dir, 'backups') })
    const keyFile = path.join(dir, 'master.key')
    writeFileSync(keyFile, key + '\n', { mode: 0o600 })
    return { backup: b.backupPath, keyFile, key, source }
  } finally {
    if (prev.env === undefined) delete process.env.DAZL_ENV; else process.env.DAZL_ENV = prev.env
    if (prev.key === undefined) delete process.env.DAZL_MASTER_KEY; else process.env.DAZL_MASTER_KEY = prev.key
  }
}
