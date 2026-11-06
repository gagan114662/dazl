// #916: the real CSV import and resume routes. A batch's validated budget is recorded at creation and every resumed row
// runs under exactly that restriction (pause at the free quota, month rollover, resume). after() is captured, never run:
// no runner, no provider call. The plan gate reads the shared store (Pro); the per-row quota reads the scan store (Free).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'

process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
let fetches = 0
globalThis.fetch = (async (u: unknown) => { fetches++; throw new Error(`network fenced: ${String(u)}`) }) as typeof fetch
const { setDb, sqliteDb } = await import('../../lib/db/client.ts')
const { migrateAllSqlite } = await import('../../lib/db/sqlite-migrations.ts')
const { saveKey } = await import('../../lib/llm/key-store.ts')
const { setPlan } = await import('./plan-fixture.ts')
const { BATCH_UNKNOWN_BUDGET, createBatch, queuePendingRows } = await import('../../lib/scan/csv-import.ts')
const csv = await import('../../app/api/scan/csv/route.ts')
const resume = await import('../../app/api/scan/csv/[batch]/route.ts')

const req = (path: string, body: unknown) => new NextRequest(`https://dazl.test${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', host: 'dazl.test', origin: 'https://dazl.test' } })
let n = 0
function world() {
  const scan = new Database(':memory:'); migrateAllSqlite(scan); setScanDb(scan)
  const sharedRaw = new Database(':memory:'); migrateAllSqlite(sharedRaw); setDb(sqliteDb(sharedRaw))
  const T = `t${++n}`.padEnd(32, 'x')
  setUser({ id: T, business_name: 'Acme', email: 'owner@example.test' } as never)
  sharedRaw.prepare("INSERT INTO tenant_plans (tenant_id, plan) VALUES (?, 'pro')").run(T)
  setPlan(scan, T, 'free')   // the scan store's quota: Free, 50 a month
  saveKey(scan, T, 'anthropic', 'sk-ant-api03-FIXTUREFIXTUREFIXTUREFIXTURE', Buffer.from(process.env.DAZL_MASTER_KEY!, 'base64'))
  const ins = scan.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location) VALUES (?, ?, 'Acme', 'x', 'y')")
  for (let i = 0; i < 49; i++) ins.run(`old${T}${i}`.slice(0, 40), T)   // 49 of 50 used: the import queues 1 row, then pauses
  const rollover = () => scan.prepare("UPDATE scan_jobs SET created_at = created_at - 40 * 86400 WHERE user_id = ? AND csv_domain IS NULL").run(T)
  const jobs = () => scan.prepare("SELECT csv_domain, run_budget FROM scan_jobs WHERE user_id = ? AND csv_domain IS NOT NULL ORDER BY csv_domain").all(T) as { csv_domain: string; run_budget: string | null }[]
  return { scan, T, rollover, jobs }
}
const importCsv = async (body: Record<string, unknown>) => { const r = await csv.POST(req('/api/scan/csv', { csv: 'a.com\nb.com\nc.com\n', ...body })); return { status: r.status, body: await r.json() as Record<string, unknown> } }
const doResume = async (batch: string) => { const r = await resume.POST(req(`/api/scan/csv/${batch}`, {}), { params: Promise.resolve({ batch }) }); return { status: r!.status, body: await r!.json() as Record<string, unknown> } }

const BUDGETS: (Record<string, false> | null)[] = [
  { paid_fallback: false }, { credit_enrichment: false }, { judge: false },
  { paid_fallback: false, credit_enrichment: false }, { paid_fallback: false, credit_enrichment: false, judge: false },
  null,   // an explicitly unrestricted batch (no budget field) stays unrestricted
]
for (const budget of BUDGETS) {
  test(`import ${JSON.stringify(budget)} -> pause at quota -> month rollover -> resume: every row keeps exactly that budget`, async () => {
    const w = world(); const before = fetches
    const im = await importCsv(budget ? { budget } : {})
    assert.equal(im.status, 202); assert.equal(im.body.queued, 1); assert.equal(im.body.quota_stop, true)
    w.rollover()
    const r1 = await doResume(im.body.batch_id as string)
    assert.equal(r1.status, 202); assert.deepEqual(r1.body.budget, budget); assert.equal(r1.body.budget_recorded, true)
    const want = budget ? JSON.stringify(budget) : null
    assert.deepEqual(w.jobs(), ['a.com', 'b.com', 'c.com'].map(d => ({ csv_domain: d, run_budget: want })))
    // repeat resume: idempotent, no duplicate jobs
    const r2 = await doResume(im.body.batch_id as string)
    assert.equal(r2.status, 202); assert.equal(w.jobs().length, 3)
    assert.equal((w.scan.prepare('SELECT count(*) n FROM csv_rows WHERE batch_id = ? AND job_id IS NULL').get(im.body.batch_id) as { n: number }).n, 0)
    assert.equal(fetches, before, 'no provider request')
  })
}

test('malformed budgets are refused before a batch exists', async () => {
  const w = world()
  for (const bad of [null, {}, { paid_fallback: true }, { judge: 0 }, { nope: false }, 'x', []]) {
    const r = await importCsv({ budget: bad }); assert.equal(r.status, 400, JSON.stringify(bad))
  }
  assert.equal((w.scan.prepare('SELECT count(*) n FROM csv_batches').get() as { n: number }).n, 0)
})

test('tenant isolation: another tenant cannot resume the batch, and its rows stay pending under the owner budget', async () => {
  const w = world()
  const im = await importCsv({ budget: { judge: false } })
  w.rollover()
  setUser({ id: 'z'.repeat(32), business_name: 'Other', email: 'o@example.test' } as never)
  assert.equal((await doResume(im.body.batch_id as string)).status, 404)
  assert.equal(w.jobs().length, 1)
})

test('a pre-#916 batch (no recorded budget) resumes under every narrowing control, never unrestricted', async () => {
  const w = world()
  const b = createBatch(w.scan, w.T, ['old1.com', 'old2.com'])
  w.scan.prepare('UPDATE csv_batches SET budget_recorded = 0, run_budget = NULL WHERE id = ?').run(b)   // as migrated from before the column
  w.rollover()
  const r = await doResume(b)
  assert.equal(r.status, 202); assert.equal(r.body.budget_recorded, false); assert.deepEqual(r.body.budget, JSON.parse(BATCH_UNKNOWN_BUDGET))
  assert.ok(w.jobs().every(j => j.run_budget === BATCH_UNKNOWN_BUDGET))
  // a stored value that no longer validates is treated the same way
  const b2 = createBatch(w.scan, w.T, ['old3.com'], JSON.stringify({ judge: false }))
  w.scan.prepare(`UPDATE csv_batches SET run_budget = '{"judge":true}' WHERE id = ?`).run(b2)
  queuePendingRows(w.scan, w.T, b2)
  assert.equal((w.scan.prepare("SELECT run_budget FROM scan_jobs WHERE csv_domain = 'old3.com'").get() as { run_budget: string }).run_budget, BATCH_UNKNOWN_BUDGET)
})

test('a failed row link leaves no orphan job: insert and link commit together', async () => {
  const w = world()
  w.rollover()
  const b = createBatch(w.scan, w.T, ['x1.com', 'x2.com'], JSON.stringify({ judge: false }))
  w.scan.exec(`CREATE TRIGGER fail_link BEFORE UPDATE OF job_id ON csv_rows WHEN (SELECT domain FROM csv_rows WHERE id = NEW.id) = 'x2.com' BEGIN SELECT RAISE(ABORT, 'link failed'); END`)
  assert.throws(() => queuePendingRows(w.scan, w.T, b), /link failed/)
  assert.deepEqual(w.jobs().map(j => j.csv_domain), ['x1.com'], 'x2.com has no orphan job')
  w.scan.exec('DROP TRIGGER fail_link')
  queuePendingRows(w.scan, w.T, b)
  assert.deepEqual(w.jobs(), [{ csv_domain: 'x1.com', run_budget: '{"judge":false}' }, { csv_domain: 'x2.com', run_budget: '{"judge":false}' }])
})
