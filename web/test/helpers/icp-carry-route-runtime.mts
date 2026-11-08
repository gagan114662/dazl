// The saved business profile carried into a FIRST scan (reviewed: false) is NOT a fresh review: presence in the
// visible fields must not confirm a sourced statement, removal must not reject one, and the offer question is not
// answered by the binding alone. Explicit rejections still strip their own text from the effective profile, explicit
// Add/Dismiss events are still recorded, and the canonical fields (window_days, country, language) survive verbatim.
// The default (reviewed) path is unchanged. Real /api/scan route, real DB, stubbed runner; no network, no provider.
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
import { GET as latestGET } from '../../app/api/scan/latest/route.ts'

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
  const stored = toStored(r)
  // One statement the person already dismissed in Build: its text still sits in the saved flat fields (the auto-save
  // put it there); the carry must strip it from the EFFECTIVE profile without resurrecting or confirming anything.
  stored.hyps.push({ i: 'acme-booking:persona:testdismiss', o: 'acme-booking', k: 'persona', t: 'dental influencers', s: 'rejected', u: PAGES[0].url, q: null, at: null })
  return stored
}
// The saved business buyer: 'practice managers' kept in the visible field by the auto-save, never reviewed.
const savedBuyer = (r: IcpResearch): Icp => ({ summary: 'Dental practices that need booking software.', who: ['practice managers', 'dental influencers'], industries: [], sizes: [], where: [], signals: [], exclude: [], country: 'US', language: 'en', window_days: 180, research: r })
const storedJob = (db: Database.Database, jobId: string) => {
  const row = db.prepare('SELECT icp, offer, icp_inferred FROM scan_jobs WHERE id = ?').get(jobId) as { icp: string; offer: string | null; icp_inferred: number | null }
  return { icp: JSON.parse(row.icp) as Icp, offer: row.offer, icp_inferred: row.icp_inferred }
}
const hyp = (r: IcpResearch | undefined, text: string): ResearchedHyp => r!.hyps.find(h => h.t === text)!
const done = (db: Database.Database) => { db.prepare("UPDATE scan_jobs SET status = 'running' WHERE status = 'pending'").run(); db.prepare("UPDATE scan_jobs SET status = 'done' WHERE status = 'running'").run() }

test('POST /api/scan with reviewed: false carries the saved profile whole without implicit review; default path unchanged', async () => {
  const db = new Database(':memory:')
  try {
    migrateScan(db); migrateMemory(db); migrateKeys(db); migratePlans(db); migrateSpendPools(db); migratePlatform(db)
    db.exec('CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, sells TEXT, website TEXT)')
    db.prepare("INSERT INTO users (id, email, sells, website) VALUES ('A', 'a@example.test', 'Acme Booking', 'acme.example')").run()
    saveKey(db, 'A', 'anthropic', 'sk-ant-synthetic-test-key')
    setScanDb(db); setAuthDb(db); setDb(sqliteDb(db))

    // 1. reviewed: false - mere presence is not a confirmation.
    const r1 = await POST(request({ query: 'dental practices in Ohio hiring front desk', icp: savedBuyer(research()), reviewed: false }))
    const b1 = await r1.json() as { job_id?: string; error?: string }
    assert.equal(r1.status, 202, JSON.stringify(b1))
    const s1 = storedJob(db, b1.job_id!)
      assert.equal(hyp(s1.icp.research, 'practice managers').s, 'sourced', 'carried as stored: field text did NOT confirm it')
    assert.equal(hyp(s1.icp.research, 'front-desk leads').s, 'sourced')
    assert.equal(hyp(s1.icp.research, 'dental influencers').s, 'rejected', 'the explicit rejection survives')
    assert.deepEqual(s1.icp.who, ['practice managers'], 'rejection precedence still strips the dismissed text from the effective profile')
    assert.equal(s1.icp.window_days, 180, 'canonical fields carry verbatim')
    assert.equal(s1.icp.country, 'US')
    assert.equal(s1.icp.language, 'en')
    assert.equal(s1.icp.research!.ans, null, 'no offer answer is recorded from the binding alone')
    done(db) // the first scan finishes; only then can the repeat start

    // 1b. The raw carry is DURABLE: the job records it (icp_inferred = 3), /api/scan/latest reads it back as
    // 'carried', and the restored exact-sentence repeat - posted the way the client does from that source - still
    // confirms nothing and answers nothing. Only an explicit review event may ever promote.
    assert.equal(s1.icp_inferred, 3, 'the stored job itself records the carry: a later reload cannot read it as reviewed')
    const latest = await (await latestGET()).json() as { query: string | null; icp: Icp | null; icp_source: string | null }
    assert.equal(latest.icp_source, 'carried', 'the reload channel names the origin: carried, not user-reviewed')
    assert.deepEqual(latest.icp, s1.icp, 'the restored profile is the stored one, whole')
    const r1b = await POST(request({ query: 'dental practices in Ohio hiring front desk', icp: latest.icp, reviewed: false }))
    const b1b = await r1b.json() as { job_id?: string; error?: string }
    assert.equal(r1b.status, 202, JSON.stringify(b1b))
    const s1b = storedJob(db, b1b.job_id!)
    assert.equal(hyp(s1b.icp.research, 'practice managers').s, 'sourced', 'the repeat still confirms nothing')
    assert.equal(hyp(s1b.icp.research, 'front-desk leads').s, 'sourced')
    assert.equal(hyp(s1b.icp.research, 'dental influencers').s, 'rejected', 'the explicit rejection survives the repeat too')
    assert.equal(s1b.icp.research!.ans, null, 'the repeat still records no offer answer')
    assert.equal(s1b.icp_inferred, 3, 'the repeat is durable raw carry again')
    const latest2 = await (await latestGET()).json() as { icp_source: string | null }
    assert.equal(latest2.icp_source, 'carried', 'still carried after the repeat')

    // 2. reviewed: false with an EXPLICIT reject event for a statement whose text sits in the fields: the event is
    // recorded with the job, and the effective profile drops the text (the decision, not the carry, is the review).
    done(db)
    const r2 = await POST(request({ query: 'dental practices in Ohio hiring front desk', icp: savedBuyer(research()), reviewed: false, research_decisions: [{ offer: 'acme-booking', hypothesis: hyp(research(), 'practice managers').i, action: 'reject' }] }))
    const b2 = await r2.json() as { job_id?: string; error?: string }
    // decisionRows fail-closed check: the reject action must MATCH the profile (text present in who) or 400.
    assert.equal(r2.status, 400, JSON.stringify(b2))
    assert.equal(b2.error, 'invalid_research_decisions', 'a reject for present text is inconsistent - fail closed, nothing queued')
    assert.equal((db.prepare('SELECT COUNT(*) n FROM scan_jobs').get() as { n: number }).n, 2, 'no job was created (the carry and its repeat are the only jobs)')

    // 3. A consistent explicit confirm (text present) IS recorded with the job under reviewed: false.
    const r3 = await POST(request({ query: 'dental practices in Ohio hiring front desk', icp: savedBuyer(research()), reviewed: false, research_decisions: [{ offer: 'acme-booking', hypothesis: hyp(research(), 'practice managers').i, action: 'confirm' }] }))
    const b3 = await r3.json() as { job_id?: string; error?: string }
    assert.equal(r3.status, 202, JSON.stringify(b3))
    const dec = db.prepare("SELECT action, job_id, text FROM seller_decisions WHERE tenant_id = 'A' ORDER BY created_at").all() as { action: string; job_id: string; text: string }[]
    assert.equal(dec.length, 1)
    assert.equal(dec[0].action, 'confirm')
    assert.equal(dec[0].job_id, b3.job_id)
    assert.equal(dec[0].text, 'practice managers')

    // 4. The default path (no reviewed flag) keeps the reviewed-draft semantics: presence confirms.
    done(db)
    const r4 = await POST(request({ query: 'dental practices in Ohio hiring front desk', icp: savedBuyer(research()) }))
    const b4 = await r4.json() as { job_id?: string; error?: string }
    assert.equal(r4.status, 202, JSON.stringify(b4))
    const s4 = storedJob(db, b4.job_id!)
    assert.equal(hyp(s4.icp.research, 'practice managers').s, 'reviewed', 'default: the reviewed-draft semantics are unchanged')
    assert.equal(s4.icp_inferred, 0, 'a review-flow submit stores as user-reviewed')
  } finally { db.close() }
})
