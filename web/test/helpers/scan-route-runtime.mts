// Route-boundary regression for #379: POST /api/scan binds the reviewed-draft semantics to the play's EFFECTIVE offer
// (seller snapshot / tenant profile) when the request omits `offer`, honors a persisted deletion on the next play,
// and keeps the conflict 409 ahead of any binding. No runner, no network, no provider calls.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb } from './sequence-route-db.ts'
import { setAuthDb } from './scan-route-auth-db.ts'
import { sqliteDb, setDb } from '../../lib/db/client.ts'
import { migrateScan } from '../../lib/scan/store.ts'
import { migrateMemory } from '../../lib/memory.ts'
import { migrateKeys, saveKey } from '../../lib/llm/key-store.ts'
import { migratePlans } from '../../lib/plans.ts'
import { migrateSpendPools } from '../../lib/llm/spend-pool.ts'
import { migratePlatform } from '../../lib/db/platform-tables.ts'
import { providers } from '../../lib/llm/provider.ts'
import { buildResearch, toStored } from '../../lib/scan/seller-research.ts'
import type { Icp, IcpResearch, ResearchedHyp } from '../../lib/scan/icp.ts'
import { POST } from '../../app/api/scan/route.ts'

process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
for (const [, p] of Object.entries(providers)) { if (p.complete) p.complete = async () => { throw new Error('Unexpected provider call') } }
globalThis.fetch = (async (url: unknown) => { throw new Error(`Unexpected network call to ${String(url)}`) }) as typeof fetch
const request = (body: unknown) => new NextRequest('http://localhost/api/scan', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})

const PAGES = [{ url: 'https://acme.example/products/booking', kind: 'product' as const, title: 'Booking', text: 'Acme Booking lets practice managers fill their appointment book and helps front-desk leads cut no-shows for clinics.', fetched_at: 1800000000 }]
const research = (): IcpResearch => {
  const r = buildResearch({ offers: [{ id: 'o1', name: 'Acme Booking' }], items: [
    { offer: 'o1', kind: 'persona', text: 'practice managers', url: PAGES[0].url, quote: 'lets practice managers fill their appointment book', inferred: false },
    { offer: 'o1', kind: 'persona', text: 'front-desk leads', url: PAGES[0].url, quote: 'helps front-desk leads cut no-shows', inferred: false },
  ] }, PAGES, 'acme.example')
  if ('error' in r) throw new Error('fixture')
  return toStored(r)
}
const icpWith = (r: IcpResearch, who: string[]): Icp => ({ summary: 'Dental practices that need booking software.', who, industries: [], sizes: [], where: [], signals: [], exclude: [], research: r })
const storedIcp = (db: Database.Database, jobId: string) => {
  const row = db.prepare('SELECT icp, offer FROM scan_jobs WHERE id = ?').get(jobId) as { icp: string; offer: string | null }
  return { icp: JSON.parse(row.icp) as Icp, offer: row.offer }
}
const hyp = (r: IcpResearch, text: string): ResearchedHyp => r.hyps.find(h => h.t === text)!
const done = (db: Database.Database) => { db.prepare("UPDATE scan_jobs SET status = 'running' WHERE status = 'pending'").run(); db.prepare("UPDATE scan_jobs SET status = 'done' WHERE status = 'running'").run() }

test('scan route: omitted offer binds by the play effective offer; persisted deletion wins; conflict still 409', async () => {
  const db = new Database(':memory:')
  try {
    migrateScan(db); migrateMemory(db); migrateKeys(db); migratePlans(db); migrateSpendPools(db); migratePlatform(db)
    db.exec('CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, sells TEXT, website TEXT)')
    db.prepare("INSERT INTO users (id, email, sells, website) VALUES ('A', 'a@example.test', 'Acme Booking', 'acme.example')").run()
    saveKey(db, 'A', 'anthropic', 'sk-ant-synthetic-test-key')
    setScanDb(db); setAuthDb(db); setDb(sqliteDb(db))

    // 1. Request omits `offer`: the binding must use the play's effective offer (profile offer 'Acme Booking').
    const r1 = await POST(request({ query: 'dental practices in Ohio hiring front desk', icp: icpWith(research(), ['practice managers']) }))
    const b1 = await r1.json() as { job_id?: string; error?: string }
    assert.equal(r1.status, 202, JSON.stringify(b1))
    const s1 = storedIcp(db, b1.job_id!)
    assert.equal(s1.offer, null, 'no stated offer: none persisted on the play')
    assert.equal(hyp(s1.icp.research!, 'practice managers').s, 'reviewed', 'draft-kept statement confirmed via the effective offer')
    assert.equal(hyp(s1.icp.research!, 'front-desk leads').s, 'sourced', 'unseen sourced statement is NOT rejected')
    assert.deepEqual(s1.icp.who, ['practice managers'], 'stored profile is the reviewed draft verbatim')

    // 2. Next play: the person removed 'practice managers' from the draft -> the persisted review honors the deletion.
    done(db)
    const r2 = await POST(request({ query: 'dental practices in Ohio hiring front desk', icp: icpWith(s1.icp.research!, []) }))
    const b2 = await r2.json() as { job_id?: string; error?: string }
    assert.equal(r2.status, 202, JSON.stringify(b2))
    const s2 = storedIcp(db, b2.job_id!)
    assert.equal(hyp(s2.icp.research!, 'practice managers').s, 'rejected', 'a deleted previously-confirmed statement is an explicit rejection')
    assert.deepEqual(s2.icp.who, [], 'the deletion is not re-injected')

    // 3. A request stating a DIFFERENT offer than the recorded one still conflicts before any binding.
    done(db)
    const r3 = await POST(request({ query: 'Selling Acme Payroll to dental practices in Ohio', icp: icpWith(research(), []) }))
    const b3 = await r3.json() as { error?: string }
    assert.equal(r3.status, 409, JSON.stringify(b3))
    assert.equal(b3.error, 'offer_conflict')

    // 4. A stated offer binds by itself and is persisted with the play.
    done(db)
    const r4 = await POST(request({ query: 'dental practices in Ohio hiring front desk', offer: 'Acme Booking', icp: icpWith(research(), ['practice managers']) }))
    const b4 = await r4.json() as { job_id?: string; error?: string }
    assert.equal(r4.status, 202, JSON.stringify(b4))
    const s4 = storedIcp(db, b4.job_id!)
    assert.equal(s4.offer, 'Acme Booking')
    assert.equal(hyp(s4.icp.research!, 'practice managers').s, 'reviewed')
  } finally { db.close() }
})
