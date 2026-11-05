// Route seam for #386 (real POST /api/scan/lookalike and GET /api/leads handlers, stubbed session, synthetic rows, no
// network): a cold account posts representative customers + negatives and gets features, a held-out check and a profile;
// leads of a scan stored with that profile carry a lookalike-fit label apart from intent.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { createJob } from '../../lib/scan/store.ts'
import { normalizeIcp } from '../../lib/scan/icp.ts'
import { POST as lookalikePOST } from '../../app/api/scan/lookalike/route.ts'
import { GET as leadsGET } from '../../app/api/leads/route.ts'

globalThis.fetch = (async () => { throw new Error('Unexpected network call') }) as typeof fetch
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
let n = 0
const post = (body: unknown) => lookalikePOST(new NextRequest('http://localhost/api/scan/lookalike', { method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost', origin: 'http://localhost', 'x-forwarded-for': `10.4.0.${++n}` }, body: JSON.stringify(body) }))
const cust = (i: number) => ({ kind: i % 7 === 0 ? 'won' : 'customer', name: `Bright Smile ${i} Dental`, domain: `brightsmile${i}.example`, industry: 'Dental clinics', size: '11-50', location: 'New York', description: 'orthodontic invisalign family practice' })
const neg = (i: number) => ({ kind: i % 5 === 0 ? 'competitor' : 'negative', name: `Other ${i} Works`, domain: `other${i}.example`, industry: i % 2 ? 'Manufacturing' : 'Legal services', size: i % 3 ? '1000+' : '2-10', location: i % 2 ? 'Ohio' : 'Texas', description: i % 2 ? 'industrial fabrication machining' : 'litigation counsel firm' })
const COHORT = [...Array.from({ length: 24 }, (_, i) => cust(i)), ...Array.from({ length: 24 }, (_, i) => neg(i))]
function seed() {
  const db = new Database(':memory:'); migrateAllSqlite(db); setScanDb(db)
  setUser({ id: 'A', business_name: 'Acme' })
  return db
}

test('POST: refuses a cohort without negatives / malformed rows before computing anything; a valid one returns features, held-out check and a storable profile', async () => {
  seed()
  const noNeg = await post({ examples: COHORT.slice(0, 24) })
  assert.equal(noNeg.status, 200); const nn = await noNeg.json() as { state: string; proposal: unknown }
  assert.equal(nn.state, 'needs_negatives'); assert.equal(nn.proposal, null)
  const bad = await post({ examples: [{ kind: 'lead', name: 'X Dental' }] }); assert.equal(bad.status, 400); assert.equal((await bad.json() as { error: string }).error, 'invalid_cohort')
  const res = await post({ examples: COHORT }); assert.equal(res.status, 200)
  const out = await res.json() as { state: string; features: { reason: string }[]; held_out: { precision: number; chance: number }; counts: Record<string, number>; proposal: { query: string; icp: unknown } }
  assert.equal(out.state, 'ready'); assert.ok(out.held_out.precision > out.held_out.chance)
  assert.deepEqual(out.counts, { customers: 24, negatives: 19, competitors: 5 })
  assert.ok(out.features.length > 0 && out.features.every(f => /vs non-customers$/.test(f.reason)))
  assert.ok(normalizeIcp(out.proposal.icp), 'the profile is accepted as POST /api/scan stores it')
})

test('GET /api/leads on a lookalike scan: fit label with reasons from the lead\'s evidence; "with event" only with proof-backed timing', async () => {
  const db = seed()
  const out = await (await post({ examples: COHORT })).json() as { proposal: { query: string; icp: unknown } }
  const j = createJob(db, 'A', { business_name: 'Synthetic A', industry: 'test', location: 'test' })
  db.prepare("UPDATE scan_jobs SET status='running', query=?, icp=? WHERE id=?").run(out.proposal.query, JSON.stringify(normalizeIcp(out.proposal.icp)), j)
  const ins = (company: string, excerpt: string, date: string | null, proof: string | null) => {
    const id = randomBytes(12).toString('hex')
    db.prepare("INSERT INTO leads(id,scan_job_id,company,name,contact,signal,source_url,evidence_excerpt,confidence,score,fit,intent,action,why,signal_kind,event_date,event_date_proof,company_domain) VALUES(?,?,?,'Pat','pat@x.test','Opened a second clinic','https://x.invalid/a',?,80,70,4,4,3,'Fits.','expansion',?,?,?)")
      .run(id, j, company, excerpt, date, proof, `${company.toLowerCase().replace(/\W+/g, '')}.test`)
    return id
  }
  const proven = ins('Maple Row Dental', 'Maple Row Dental, an orthodontic practice in New York, opened a second clinic', daysAgo(5), 'page_bound')
  const unproven = ins('Harbor Orthodontics', 'Harbor, an invisalign provider in New York, opened a second clinic', null, null)
  const res = await leadsGET(new NextRequest(`http://test/api/leads?job_id=${j}`))
  const rows = (await res.json() as { leads: { id: string; intent: number; timing: string; lookalike_fit: { readiness: string; label: string; reasons: string[]; fit: number } | null }[] }).leads
  const by = Object.fromEntries(rows.map(r => [r.id, r]))
  assert.equal(by[proven].timing, 'proof_backed'); assert.equal(by[proven].lookalike_fit!.readiness, 'lookalike_with_event')
  assert.equal(by[unproven].timing, 'unconfirmed'); assert.equal(by[unproven].intent, 0, 'lookalike fit never lifts intent')
  assert.equal(by[unproven].lookalike_fit!.readiness, 'lookalike_only'); assert.match(by[unproven].lookalike_fit!.label, /no verified current intent/)
  for (const r of rows) { assert.ok(r.lookalike_fit!.fit > 0 && r.lookalike_fit!.reasons.length > 0); assert.doesNotMatch(JSON.stringify(r.lookalike_fit), /ready.to.buy/i) }
  // a scan without a lookalike profile carries no lookalike label at all
  const plain = createJob(db, 'A', { business_name: 'Synthetic B', industry: 'test', location: 'test' })
  db.prepare("UPDATE scan_jobs SET status='running' WHERE id=?").run(plain)
  db.prepare("UPDATE leads SET scan_job_id=? WHERE id=?").run(plain, unproven)
  const p = (await (await leadsGET(new NextRequest(`http://test/api/leads?job_id=${plain}`))).json() as { leads: { lookalike_fit: unknown }[] }).leads
  assert.deepEqual(p.map(r => r.lookalike_fit), [null])
})
