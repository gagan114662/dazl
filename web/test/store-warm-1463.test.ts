import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'

// #1463: the proxy bundle's own store must be opened (migrations run) by the first request it sees, normally the
// deploy's health probe, not by a user's first signed-in /app request after a deploy.

test('warmStore opens the real store and runs its migrations once', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dazl-warm-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  process.env.DB_PATH = join(dir, 'app.db')
  delete process.env.DATABASE_URL
  const { getDb } = await import('../lib/db/client.ts')
  const { warmStore } = await import('../lib/store-warm.ts')
  let opens = 0
  const counted = () => { opens++; return getDb() }
  const first = warmStore(counted), second = warmStore(counted)
  assert.equal(first, second, 'concurrent first requests share one open')
  await first
  assert.equal(opens, 1)
  const raw = new Database(process.env.DB_PATH, { readonly: true })
  const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('users','sessions')").all()
  raw.close()
  assert.equal(tables.length, 2, 'the migrations ran during the warm, before any session lookup')
})

test('a failed warm is retried by the next request instead of being cached', async () => {
  const { warmStore, resetStoreWarmForTest } = await import('../lib/store-warm.ts')
  resetStoreWarmForTest()
  let calls = 0
  await assert.rejects(warmStore(async () => { calls++; throw new Error('disk') }))
  await warmStore(async () => { calls++; return {} as never })
  assert.equal(calls, 2)
})

test('proxy.ts warms its store first, on every matched path including the health probe', () => {
  const src = readFileSync(new URL('../proxy.ts', import.meta.url), 'utf8')
  const body = src.slice(src.indexOf('export async function proxy'))
  assert.ok(body.indexOf('warmStore(getDb)') > 0 && body.indexOf('warmStore(getDb)') < body.indexOf("pathname.startsWith('/app')"), 'warm runs before the /app session check')
  assert.match(src, /matcher: \['\/app\/:path\*', '\/api\/:path\*'/, '/api/health goes through the proxy')
})
