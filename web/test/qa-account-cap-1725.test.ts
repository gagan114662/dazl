import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { sharedPool, poolRows } from '../lib/llm/spend-pool.ts'
import { runWithAccountSpend, runWithScanSpend, scanCapConfig, reserveScanSpend } from '../lib/scan/spend-cap.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { estimateForBody } from '../lib/scan/estimate-request.ts'
import { sqliteDb } from '../lib/db/client.ts'

const NOW = Date.parse('2026-11-25T15:00:00Z') / 1_000
const LIMITS = { day: 10, month: 100 }
function fixture() {
  const db = new Database(':memory:')
  migrateAllSqlite(db)
  db.prepare("INSERT INTO users (id,email,password_hash,salt,email_verified_at) VALUES ('qa','approved@example.test','h','s',1)").run()
  db.prepare("INSERT INTO users (id,email,password_hash,salt,email_verified_at) VALUES ('other','approved+alias@example.test','h','s',1)").run()
  return db
}

test('1725 configured QA identity shares a hard dollar across pooled models and transport enrichment', async () => {
  const old = process.env.DAZL_TRIAL_QA_EXEMPT
  process.env.DAZL_TRIAL_QA_EXEMPT = 'approved@example.test'
  const db = fixture()
  try {
    const p = sharedPool(db, 'qa', LIMITS, () => NOW)
    await p.reserve(0.8)
    let sent = 0
    await assert.rejects(runWithAccountSpend({ db, tenantId: 'qa', limits: LIMITS, clock: () => NOW }, async () => {
      await reserveScanSpend('apollo.org', () => 0.3)
      sent++
    }))
    assert.equal(sent, 0)
    const day = (await poolRows(db, 'qa')).find(r => r.period === 'd:2026-11-25')
    assert.equal(day?.reserved_usd, 0.8, 'refusal preserves existing billed and pending spend')
    await sharedPool(db, 'other', LIMITS, () => NOW).reserve(2)
    await p.reserve(0.2)
    await assert.rejects(p.reserve(0.001))
  } finally {
    db.close()
    if (old === undefined) delete process.env.DAZL_TRIAL_QA_EXEMPT
    else process.env.DAZL_TRIAL_QA_EXEMPT = old
  }
})

function withPolicy(t: test.TestContext) {
  const old = process.env.DAZL_TRIAL_QA_EXEMPT
  process.env.DAZL_TRIAL_QA_EXEMPT = 'approved@example.test'
  t.after(() => {
    if (old === undefined) delete process.env.DAZL_TRIAL_QA_EXEMPT
    else process.env.DAZL_TRIAL_QA_EXEMPT = old
  })
}

test('1725 UTC rollover retains unknown old-day money and exact end-of-Nov27 Eastern expiry', async t => {
  withPolicy(t)
  const db = fixture()
  t.after(() => db.close())
  let at = Date.parse('2026-11-27T23:59:59Z') / 1_000
  const pool = () => sharedPool(db, 'qa', LIMITS, () => at)
  await pool().reserve(1)
  await assert.rejects(pool().reserve(0.01))
  at++
  await pool().reserve(1)
  await assert.rejects(pool().reserve(0.01), 'Nov27 Eastern still protected after UTC midnight')
  at = Date.parse('2026-11-28T04:59:59Z') / 1_000
  await assert.rejects(pool().reserve(0.01))
  at++
  await pool().reserve(1)
  const days = (await poolRows(db, 'qa')).filter(r => r.period.startsWith('d:'))
  assert.deepEqual(days.map(r => r.reserved_usd), [1, 2])
})

test('1725 unknown usage is never a refund and all transport kinds stop at account cap', async t => {
  withPolicy(t)
  const db = fixture()
  t.after(() => db.close())
  const ctx = { db, tenantId: 'qa', limits: LIMITS, clock: () => NOW }
  const hold = await runWithAccountSpend(ctx, () => reserveScanSpend('llm.anthropic', () => 1))
  assert.ok(hold)
  await hold.settle(null)
  for (const kind of ['llm.anthropic', 'apollo.org', 'pdl.people', 'tinyfish.search', 'render'] as const) {
    await assert.rejects(runWithAccountSpend({ ...ctx }, () => reserveScanSpend(kind, () => kind === 'tinyfish.search' ? 0 : 0.01)))
  }
  assert.equal((await poolRows(db, 'qa')).find(r => r.period === 'd:2026-11-25')?.reserved_usd, 1)
})

test('1725 separate processes atomically share one QA account dollar and restart cannot replenish it', async t => {
  withPolicy(t)
  const dir = mkdtempSync(join(tmpdir(), 'dazl-qa-cap-1725-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'cap.db')
  const db = new Database(path)
  migrateAllSqlite(db)
  db.prepare("INSERT INTO users (id,email,password_hash,salt) VALUES ('qa','approved@example.test','h','s')").run()
  db.close()
  const child = () => promisify(execFile)(process.execPath, ['--experimental-strip-types',
    '--import', './test/helpers/net-fence.ts', './test/helpers/qa-cap-1725-child.mts', path, String(NOW)])
  const replies = await Promise.all(Array.from({ length: 8 }, child))
  assert.equal(replies.reduce((n, r) => n + Number(r.stdout.trim()), 0), 4)
  assert.equal(Number((await child()).stdout.trim()), 0)
})

test('1725 preflight headroom uses the same QA account dollar before any job insert', async t => {
  withPolicy(t)
  const db = fixture()
  t.after(() => db.close())
  const p = sharedPool(db, 'qa', LIMITS, () => NOW)
  await p.reserve(0.8)
  assert.ok(Math.abs((await p.headroom!()) - 0.2) < 1e-9)
})

test('1725 estimate refuses an exhausted configured QA account before starting another scan', async t => {
  withPolicy(t)
  const db = fixture()
  t.after(() => db.close())
  const now = Math.floor(Date.now() / 1_000)
  await sharedPool(db, 'qa', LIMITS, () => now).reserve(1)
  const result = await estimateForBody({ query: 'Businesses opening new branches' }, {
    db: sqliteDb(db), tenantId: 'qa', hasOwnKey: true, model: 'claude-sonnet-4-5', enrichmentVendors: [] })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.estimate.cap.max_usd, 1)
  assert.equal(result.estimate.verdict.ok, false)
  assert.equal(result.estimate.cap.remaining_usd, 0)
})

test('1725 QA native scan refuses an unbounded provider token bill even when its soft estimate fits', async t => {
  withPolicy(t)
  const db = fixture()
  t.after(() => db.close())
  db.prepare("INSERT INTO scan_jobs(id,user_id,business_name,industry,location,status,attempts) VALUES ('native','qa','Fixture','Test','Test','running',1)").run()
  let sent = 0
  await assert.rejects(runWithScanSpend({ db, jobId: 'native', tenantId: 'qa', attempt: 1,
    cap: scanCapConfig({}), accountLimits: LIMITS, nativeSearch: true, clock: () => NOW }, async () => {
    await reserveScanSpend('llm.anthropic.web_search', () => 0.3)
    sent++
  }))
  assert.equal(sent, 0)
  assert.equal((await poolRows(db, 'qa')).length, 0, 'an unsent request must consume no money')
})
