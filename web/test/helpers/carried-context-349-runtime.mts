// Original-input replay: real request admission, synthetic tenants, no runner or provider.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { setSellerLine } from './scan-route-auth-stub.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { saveKey } from '../../lib/llm/key-store.ts'
import { saveMemory } from '../../lib/memory.ts'
import { readPlayOffer } from '../../lib/scan/play-offer.ts'
import { draftOffer } from '../../lib/scan/play-offer-text.ts'
import { readTenantOffer } from '../../lib/outreach/play-memory.ts'
import { POST as ESTIMATE } from '../../app/api/scan/estimate/route.ts'
import { POST as SCAN } from '../../app/api/scan/route.ts'

process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
globalThis.fetch = (async () => { throw new Error('network fenced') }) as typeof fetch
const db = new Database(':memory:'); migrateAllSqlite(db); setScanDb(db)
const saved = 'outsourced SDR and appointment-setting services for B2B agencies'
const profile = { summary: 'Toronto agencies hiring an SDR', who: [], industries: [], where: ['Toronto'], signals: [], sizes: [], exclude: ['Never contact existing clients'] }
const query = 'SaaS startups in Austin hiring their first account executive'
function tenant(seller = saved) {
  const id = randomBytes(16).toString('hex')
  db.prepare("INSERT INTO users (id,email,name,business_name,password_hash,salt,sells,buyer_profile) VALUES (?,?,'Fixture','Seller','x','y',?,?)").run(id, id+'@example.test', seller, JSON.stringify(profile))
  saveKey(db,id,'anthropic','sk-ant...TURE',Buffer.from(process.env.DAZL_MASTER_KEY!,'base64'))
  setSellerLine(id,seller)
  return id
}
async function request(t: string, handler: typeof SCAN, body: unknown) {
  setUser({id:t,business_name:'Seller',email:t+'@example.test'} as never)
  const r = await handler(new NextRequest('http://localhost/api/scan',{method:'POST',headers:{'content-type':'application/json',host:'localhost'},body:JSON.stringify(body)}))
  return {status:r.status, ...await r.json()}
}

test('new Austin and Ontario targets replace the carried Toronto buyer while keeping the saved seller', async () => {
  for (const next of [query, 'dental clinics in Ontario opening a new location']) {
    const t=tenant()
    const before = db.prepare('SELECT * FROM users WHERE id=?').get(t)
    const estimate=await request(t,ESTIMATE,{query:next,icp:profile,reviewed:false,target_from_query:true})
    assert.equal(estimate.status,200,JSON.stringify(estimate))
    const result=await request(t,SCAN,{query:next,icp:profile,reviewed:false,target_from_query:true,estimate_ack:estimate.estimate.ack})
    assert.equal(result.status,202,JSON.stringify(result))
    const row=db.prepare('SELECT icp,icp_inferred,seller,offer FROM scan_jobs WHERE id=? AND user_id=?').get(result.job_id,t) as {icp:string;icp_inferred:number;seller:string;offer:string|null}
    const used=JSON.parse(row.icp)
    assert.equal(used.summary,next,'the run must record the actual new request, not the saved buyer')
    assert.deepEqual(used.where,[],'no Toronto targeting')
    assert.deepEqual(used.exclude,profile.exclude,'explicit exclusions survive a target change')
    assert.equal(row.icp_inferred,2,'request-derived, not a reviewed or carried profile')
    assert.equal(row.seller,saved)
    assert.equal(row.offer,null,'target words never invent a different product')
    assert.deepEqual(db.prepare('SELECT * FROM users WHERE id=?').get(t),before)
  }
})

test('a fresh query preserves carried exclusions even when no buyer profile is supplied', async () => {
  const t = tenant()
  const result = await request(t, SCAN, { query, carry_exclude: ['Do not contact existing clients'] })
  assert.equal(result.status, 202, JSON.stringify(result))
  const row = db.prepare('SELECT icp FROM scan_jobs WHERE id=? AND user_id=?').get(result.job_id, t) as { icp: string }
  assert.deepEqual(JSON.parse(row.icp).carry_exclude, ['Do not contact existing clients'])
})

test('a new play keeps the offer it took from Memory after the tenant changes it', async () => {
  const t = tenant('')
  const positioning = 'Managed hosting - example.com'
  saveMemory(db, t, { positioning })
  const estimate = await request(t, ESTIMATE, { query, icp: profile, reviewed: false })
  assert.equal(estimate.status, 200, JSON.stringify(estimate))
  const result = await request(t, SCAN, { query, icp: profile, reviewed: false, estimate_ack: estimate.estimate.ack })
  assert.equal(result.status, 202, JSON.stringify(result))

  saveMemory(db, t, { positioning: 'CRM setup and outbound sales consulting' })
  const row = db.prepare('SELECT seller, offer, offer_set_at, query FROM scan_jobs WHERE id=? AND user_id=?')
    .get(result.job_id, t) as { seller: string | null; offer: string | null; offer_set_at: number | null; query: string }
  assert.equal((await readPlayOffer(db, t, result.job_id))?.offer, positioning)
  assert.equal(draftOffer(row, readTenantOffer(db, t)).offer, positioning)
  assert.equal(row.offer_set_at, null, 'using a saved offer does not record a user review')
})

test('a seller with no offer must choose before estimate or queue, not infer a product from buyers', async () => {
  for (const handler of [ESTIMATE, SCAN]) {
    const t = tenant('')
    const result = await request(t, handler, { query, icp: profile, reviewed: false })
    assert.equal(result.status, 409, JSON.stringify(result))
    assert.equal(result.error, 'offer_conflict')
    assert.equal(result.incomplete, true)
    assert.equal(db.prepare('SELECT COUNT(*) FROM scan_jobs WHERE user_id=?').pluck().get(t), 0)
  }
})

test('explicitly reviewed targeting is not replaced and another tenant and historical play stay unchanged', async () => {
  const other = tenant('language lessons for remote workers')
  const old = await request(other, SCAN, { query: 'Remote workers in Lisbon', icp: profile, reviewed: true, offer: 'language lessons for remote workers' })
  assert.equal(old.status, 202, JSON.stringify(old))
  const before = db.prepare('SELECT * FROM scan_jobs WHERE id=?').get(old.job_id)
  const t = tenant()
  const result = await request(t, SCAN, { query, icp: profile, reviewed: true })
  assert.equal(result.status, 202, JSON.stringify(result))
  const row = db.prepare('SELECT icp,icp_inferred FROM scan_jobs WHERE id=?').get(result.job_id) as {icp:string;icp_inferred:number}
  assert.deepEqual(JSON.parse(row.icp), profile)
  assert.equal(row.icp_inferred, 0, 'a fresh explicit review is recorded as reviewed')
  assert.deepEqual(db.prepare('SELECT * FROM scan_jobs WHERE id=?').get(old.job_id), before)
})

test('explicitly reviewed same-query repeats retain their saved per-play target without new review', async () => {
  const t = tenant()
  const reviewed = { ...profile, who: ['Clinic owner'], where: ['Ottawa'], signals: ['opening another office'] }
  const first = await request(t, SCAN, { query, icp: reviewed, reviewed: true })
  assert.equal(first.status, 202, JSON.stringify(first))
  db.prepare("UPDATE scan_jobs SET status='running', attempts=1, claimed_at=1 WHERE id=?").run(first.job_id)
  db.prepare("UPDATE scan_jobs SET status='done', claimed_at=NULL WHERE id=?").run(first.job_id)
  const repeated = await request(t, SCAN, { query, icp: reviewed, reviewed: false })
  assert.equal(repeated.status, 202, JSON.stringify(repeated))
  const row = db.prepare('SELECT icp,icp_inferred FROM scan_jobs WHERE id=?').get(repeated.job_id) as { icp:string; icp_inferred:number }
  assert.deepEqual(JSON.parse(row.icp), reviewed)
  assert.equal(row.icp_inferred, 4, 'retained authority is distinct from a fresh review and unreviewed background')
  db.prepare("UPDATE scan_jobs SET status='running', attempts=1, claimed_at=1 WHERE id=?").run(repeated.job_id)
  db.prepare("UPDATE scan_jobs SET status='done', claimed_at=NULL WHERE id=?").run(repeated.job_id)
  const third = await request(t, SCAN, { query, icp: reviewed, reviewed: false })
  assert.equal(third.status, 202, JSON.stringify(third))
  assert.deepEqual(JSON.parse((db.prepare('SELECT icp FROM scan_jobs WHERE id=?').get(third.job_id) as {icp:string}).icp), reviewed)
})

test('a stored reviewed target is retained verbatim on repeat without re-opening the review', async () => {
  const t = tenant()
  db.prepare("INSERT INTO scan_jobs(id,user_id,business_name,industry,location,query,icp,icp_inferred) VALUES (?,?, 'Fixture','-', '-',?,?,0)").run(randomBytes(12).toString('hex'), t, query, JSON.stringify(profile))
  db.prepare("UPDATE scan_jobs SET status='running',attempts=1,claimed_at=1 WHERE user_id=?").run(t)
  db.prepare("UPDATE scan_jobs SET status='done',claimed_at=NULL WHERE user_id=?").run(t)
  const result = await request(t, SCAN, { query, icp: profile, reviewed: false })
  assert.equal(result.status, 202, JSON.stringify(result))
  assert.equal(JSON.parse((db.prepare('SELECT icp FROM scan_jobs WHERE id=?').get(result.job_id) as {icp:string}).icp).summary, profile.summary)
})

test('stating an offer without any saved seller still requires explicit choice', async () => {
  for (const handler of [ESTIMATE, SCAN]) {
    const t = tenant('')
    const result = await request(t, handler, { query: 'We sell payroll software to startups', reviewed: false })
    assert.equal(result.status, 409, JSON.stringify(result))
    assert.equal(result.error, 'offer_conflict')
    assert.equal(db.prepare('SELECT COUNT(*) FROM scan_jobs WHERE user_id=?').pluck().get(t), 0)
  }
})

test('naming the current company does not imply changing its saved product', async () => {
  for (const handler of [ESTIMATE, SCAN]) {
    const t = tenant()
    const result = await request(t, handler, { query: 'Find leads for Seller', icp: profile, reviewed: false })
    assert.equal(result.status, handler === ESTIMATE ? 200 : 202, JSON.stringify(result))
  }
})

for (const next of [
  "We're a small marketing agency in Toronto", 'We are a small marketing agency in Toronto',
  'I run a dental practice in Austin', "I'm a plumber in Oakville", 'I am a plumber in Oakville',
  "I'm the owner of a ceramics studio in Kyoto", 'We are plumbers in Oakville',
  'My company sells language lessons to remote workers',
  'Our business offers bookkeeping to independent retailers',
  'My agency provides creative services to local businesses',
  'Our practice is a physiotherapy clinic in Porto',
  'We sell ceramics to restaurants', 'We offer language lessons to remote workers',
]) {
  for (const handler of [ESTIMATE, SCAN]) test(`seller self-description requires a choice at ${handler === ESTIMATE ? 'estimate' : 'scan'}: ${next}`, async () => {
    const t = tenant('a B2B sales-automation SaaS to small marketing agencies')
    const before = db.prepare('SELECT * FROM users WHERE id=?').get(t)
    const result = await request(t, handler, { query: next, icp: profile, reviewed: false })
    assert.equal(result.status, 409, JSON.stringify(result))
    assert.equal(result.error, 'offer_conflict')
    assert.equal(db.prepare('SELECT COUNT(*) FROM scan_jobs WHERE user_id=?').pluck().get(t), 0)
    assert.deepEqual(db.prepare('SELECT * FROM users WHERE id=?').get(t), before)
  })
}

test('buyer searches, exclusions, negations and quoted identities never become seller changes', async () => {
  for (const next of [
    'Find dental practices in Austin',
    'Find agencies whose owners say "I am a consultant"',
    'Exclude people who say "We are a marketing agency"',
    'We are not a dental practice. Find independent clinics in Ontario',
    'I am looking for dental practices in Austin',
    'We are seeking plumbers in Oakville',
    'Find agencies we sell to in Ontario',
    'Find owners of practices offering physiotherapy',
    'Find agencies. Exclude owners who say "My company sells language lessons"',
    'Our agency is looking for dental practices in Austin',
    'My company does not sell ceramics. Find retailers',
    'We sell to dental practices in Austin',
    'We offer to contact founders in Ontario',
  ]) for (const handler of [ESTIMATE, SCAN]) {
    const t = tenant()
    const result = await request(t, handler, { query: next, icp: profile, reviewed: false })
    assert.equal(result.status, handler === ESTIMATE ? 200 : 202, next + JSON.stringify(result))
  }
})

test('explicit play offer resolves a seller identity and survives reviewed repeat without changing saved settings', async () => {
  const t = tenant('B2B sales automation software')
  const before = db.prepare('SELECT * FROM users WHERE id=?').get(t)
  const next = 'I run a dental practice in Austin'
  const offer = 'Preventive dental care'
  const estimate = await request(t, ESTIMATE, { query: next, offer, icp: profile, reviewed: true })
  assert.equal(estimate.status, 200, JSON.stringify(estimate))
  const first = await request(t, SCAN, { query: next, offer, icp: profile, reviewed: true, estimate_ack: estimate.estimate.ack })
  assert.equal(first.status, 202, JSON.stringify(first))
  const original = db.prepare('SELECT * FROM scan_jobs WHERE id=?').get(first.job_id)
  db.prepare("UPDATE scan_jobs SET status='running',attempts=1,claimed_at=1 WHERE id=?").run(first.job_id)
  db.prepare("UPDATE scan_jobs SET status='done',claimed_at=NULL WHERE id=?").run(first.job_id)
  const historical = db.prepare('SELECT * FROM scan_jobs WHERE id=?').get(first.job_id)
  const repeat = await request(t, SCAN, { query: next, offer, icp: profile, reviewed: false })
  assert.equal(repeat.status, 202, JSON.stringify(repeat))
  const row = db.prepare('SELECT offer,icp,icp_inferred FROM scan_jobs WHERE id=?').get(repeat.job_id) as {offer:string;icp:string;icp_inferred:number}
  assert.equal(row.offer, offer)
  assert.deepEqual(JSON.parse(row.icp), profile)
  assert.equal(row.icp_inferred, 4)
  assert.deepEqual(db.prepare('SELECT * FROM scan_jobs WHERE id=?').get(first.job_id), historical)
  assert.deepEqual(db.prepare('SELECT * FROM users WHERE id=?').get(t), before)
  assert.ok(original)
})

test('carried hiring criteria do not change the estimate for a non-hiring typed target', async () => {
  const t = tenant()
  const next = 'Independent dental clinics in Ontario opening another office'
  const carried = { ...profile, signals: ['hiring their first sales representative'] }
  const fresh = await request(t, ESTIMATE, { query: next })
  const stale = await request(t, ESTIMATE, { query: next, icp: carried, reviewed: false })
  assert.equal(fresh.status, 200, JSON.stringify(fresh))
  assert.equal(stale.status, 200, JSON.stringify(stale))
  assert.deepEqual(stale.estimate.rows, fresh.estimate.rows, 'estimate uses this target, not saved hiring requirements')
})
