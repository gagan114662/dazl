import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { admitScan } from '../lib/db/admit-scan.ts'
import { PLAN_LIMITS } from '../lib/plans.ts'
import { queryJobStep } from '../lib/scan/store-db.ts'
import { bothEngines } from './helpers/engines.ts'

bothEngines('#2013 scan admission uses the last quota slot once and leaves the other tenant eligible', async ({ db }) => {
  const account = randomUUID()
  const otherAccount = randomUUID()
  const now = new Date()
  const nowS = Math.floor(now.getTime() / 1000)
  const limit = PLAN_LIMITS.free.scansPerMonth!
  for (let i = 0; i < limit - 1; i++) {
    await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, created_at) VALUES (?, ?, 'Previous scan', '-', '-', ?)", [randomUUID(), account, nowS])
  }
  const request = (query: string, offer: string) => ({ id: randomUUID(), query, offer, seller: offer })
  const contenders = [request('Find dental practices', 'Appointment scheduling'), request('Find design studios', 'Project bookkeeping')]
  const start = (tenant: string, input = request('Find new buyers', 'Inventory forecasting')) =>
    admitScan(db, tenant, { plan: 'free', now }, t => queryJobStep(t, tenant, input, nowS))
  const results = await Promise.all(contenders.map(input => start(account, input)))
  assert.equal(results.filter(result => result.ok).length, 1)
  assert.deepEqual(results.find(result => !result.ok), { ok: false, quota: { plan: 'free', used: limit, limit, allowed: false } })
  for (const [index, input] of contenders.entries()) {
    const row = await db.get('SELECT query, offer, seller FROM scan_jobs WHERE user_id = ? AND id = ?', [account, input.id])
    assert.deepEqual(row, results[index]?.ok ? { query: input.query, offer: input.offer, seller: input.seller } : undefined)
  }
  assert.equal(Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM scan_jobs WHERE user_id = ?', [account]))?.n), limit)
  const other = await start(otherAccount)
  assert.equal(other.ok, true)
  assert.equal(Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM scan_jobs WHERE user_id = ?', [otherAccount]))?.n), 1)

  await assert.rejects(admitScan(db, otherAccount, { plan: 'free', now }, function* (t) {
    yield* queryJobStep(t, otherAccount, { query: 'Discard a failed admission' }, nowS)
    throw new Error('admission write failed')
  }), /admission write failed/)
  assert.equal(Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM scan_jobs WHERE user_id = ?', [otherAccount]))?.n), 1)
}, { pgMax: 2 })
