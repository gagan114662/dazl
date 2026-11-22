import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { sqliteDb, type Db } from '../lib/db/client.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { createSession } from '../lib/auth-db.ts'
import { checkSessionWithin, SessionCheckTimeout } from '../lib/auth-gate.ts'

// Prod c52df79, 2026-11-21 ~9:05am: every /app page sat on "Opening your workspace…" for minutes, no error, no log.
// The layout's session check had no deadline, so a store or lookup that never settled kept the Suspense fallback
// up forever. These run the real check against a real store.

async function realStore(): Promise<{ db: Db; token: string }> {
  const raw = new Database(':memory:'); migrateAllSqlite(raw)
  raw.prepare("INSERT INTO users (id, email, password_hash, salt, email_confirmation_required) VALUES ('u1', 'a@b.co', 'x', 'y', 0)").run()
  const db = sqliteDb(raw)
  return { db, token: await createSession('u1', db) }
}

test('a store that never opens fails the check within the deadline, naming the step, instead of hanging', async () => {
  const { token } = await realStore()
  const lines: string[] = []
  const t = Date.now()
  await assert.rejects(checkSessionWithin(token, { getDb: () => new Promise<Db>(() => {}), ms: 50, log: l => lines.push(l) }),
    (e: unknown) => e instanceof SessionCheckTimeout && e.step === 'open_store')
  assert.ok(Date.now() - t < 2000)
  assert.match(lines.join('\n'), /"auth_gate_stalled".*"open_store"/)
})

test('a lookup that never settles fails at lookup', async () => {
  const { db, token } = await realStore()
  const stuck: Db = { ...db, get: () => new Promise(() => {}) }
  await assert.rejects(checkSessionWithin(token, { getDb: async () => stuck, ms: 50, log: () => {} }),
    (e: unknown) => e instanceof SessionCheckTimeout && e.step === 'lookup')
})

test('a live session still passes and a bad token still fails, unchanged', async () => {
  const { db, token } = await realStore()
  assert.equal(await checkSessionWithin(token, { getDb: async () => db, log: () => {} }), true)
  assert.equal(await checkSessionWithin('f'.repeat(64), { getDb: async () => db, log: () => {} }), false)
  assert.equal(await checkSessionWithin(undefined, { getDb: async () => db, log: () => {} }), false)
})

test('the /app layout uses the bounded check, not the unbounded lookup', () => {
  const src = readFileSync(new URL('../app/app/layout.tsx', import.meta.url), 'utf8')
  assert.match(src, /checkSessionWithin\(/)
  assert.doesNotMatch(src, /hasLiveSession\(/)
})

test('the proxy session check is bounded too, so a stall there cannot hold the page before the layout runs', () => {
  const src = readFileSync(new URL('../proxy.ts', import.meta.url), 'utf8')
  assert.match(src, /checkSessionWithin\(/)
  assert.doesNotMatch(src, /hasLiveSession\(/)
})

test('#1463: every check logs its timing and which stage ran it, not only the slow ones; the /app request line carries its proxy time', async () => {
  const { db, token } = await realStore()
  const lines: string[] = []
  assert.equal(await checkSessionWithin(token, { getDb: async () => db, log: l => lines.push(l), stage: 'layout' }), true)
  const l = JSON.parse(lines.find(x => x.includes('"auth_gate"')) ?? '{}')
  assert.equal(l.type, 'auth_gate'); assert.equal(l.stage, 'layout'); assert.equal(l.live, true)
  for (const k of ['open_store_ms', 'lookup_ms', 'total_ms']) assert.equal(typeof l[k], 'number', k)
  const src = readFileSync(new URL('../proxy.ts', import.meta.url), 'utf8')
  assert.match(src, /type: 'app_request'/)
})
