// Route-seam for #377 acceptance (real GET /api/leads handler, stubbed session, no network, synthetic rows): two
// equal-fit companies rank apart only when proof supports it, publication and model dates never upgrade timing, and
// both keep their fit rationale apart from the timing status.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateScan, createJob } from '../../lib/scan/store.ts'
import { migrateSourceReview } from '../../lib/scan/source-review.ts'
import { migrateWatch } from '../../lib/watch.ts'
import { migrateKeys } from '../../lib/llm/key-store.ts'
import { migratePlans } from '../../lib/plans.ts'
import { migrateConnectors, addEnrichment } from '../../lib/connectors/store.ts'
import { migrateAdvanced } from '../../lib/advanced/index.ts'
import { migrateBilling } from '../../lib/billing/stripe.ts'
import { migrateOutreach } from '../../lib/outreach/store.ts'
import { migrateAutopilot } from '../../lib/outreach/autopilot.ts'
import { migrateLedger } from '../../lib/outreach/ledger.ts'
import { migrateReplies } from '../../lib/outreach/replies.ts'
import { migrateThreadReplies } from '../../lib/replies/threads.ts'
import { migrateSequences } from '../../lib/outreach/sequences.ts'
import { migrateTrial } from '../../lib/scan/trial.ts'
import { migrateCompetitors } from '../../lib/signals/competitor-reddit.ts'
import { migrateEvents } from '../../lib/events/store.ts'
import { migrateWarm } from '../../lib/warm/connections.ts'
import { migrateSeo } from '../../lib/seo/audit.ts'
import { migrateMonitors } from '../../lib/monitors.ts'
import { migrateCsv } from '../../lib/scan/csv-import.ts'
import { migrateCommenterImport } from '../../lib/scan/commenter-import.ts'
import { migrateMemory } from '../../lib/memory.ts'
import { migrateReopen } from '../../lib/outreach/reopen.ts'
import { recordTimingProof } from '../../lib/scan/timing-proof.ts'
import { GET as leadsGET } from '../../app/api/leads/route.ts'

globalThis.fetch = (async () => { throw new Error('Unexpected network call') }) as typeof fetch

const daysAgoISO = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)


type Row = { id: string; company: string; intent: number; stored_intent: number | null; timing: string; fit_rationale: string | null; stored_why: string | null; currentness_held: boolean; timing_proof_gap: string | null }
function seed() {
  const db = new Database(':memory:')
  for (const m of [migrateScan, migrateSourceReview, migrateWatch, migrateKeys, migratePlans, migrateConnectors, migrateAdvanced, migrateBilling, migrateOutreach, migrateAutopilot, migrateLedger, migrateReplies, migrateThreadReplies, migrateSequences, migrateTrial, migrateCompetitors, migrateEvents, migrateWarm, migrateSeo, migrateMonitors, migrateCsv, migrateCommenterImport, migrateMemory, migrateReopen]) m(db)
  setScanDb(db)
  setUser({ id: 'A', business_name: 'Acme' })
  return db
}
function job(db: Database.Database) {
  const id = createJob(db, 'A', { business_name: 'Synthetic A', industry: 'test', location: 'test' })
  db.prepare("UPDATE scan_jobs SET status='running', query='dental groups that opened a new clinic in the last 30 days' WHERE id=?").run(id)
  return id
}
const ins = (db: Database.Database, j: string, company: string, score: number, why: string, date: string | null, proof: string | null, published: string | null) => {
  const id = randomBytes(12).toString('hex')
  db.prepare("INSERT INTO leads(id,scan_job_id,company,name,contact,signal,source_url,evidence_excerpt,confidence,score,fit,intent,action,why,signal_kind,event_date,event_date_proof,published_at,company_domain) VALUES(?,?,?,'Pat','pat@x.test','Opened a second clinic','https://x.invalid/a','opens a second clinic',80,?,4,4,3,?,'expansion',?,?,?,?)")
    .run(id, j, company, score, why, date, proof, published, `${company.toLowerCase().replace(/\W+/g, '')}.test`)
  return id
}
async function get(j: string) {
  const res = await leadsGET(new NextRequest(`http://test/api/leads?job_id=${j}`))
  return (await res.json() as { leads: Row[] }).leads
}
const NOTE = 'Event timing is unconfirmed. Review the source before treating this as a current buying need.'

test('a proven dated current event outranks an undated equal-fit twin; both keep their fit rationale', async () => {
  const db = seed(); const j = job(db)
  const dated = ins(db, j, 'Dated Dental', 70, 'Fits: multi-location dental group.', daysAgoISO(5), 'page_bound', null)
  // the undated twin has a fresher publication date and a higher raw score: neither may upgrade it
  const undated = ins(db, j, 'Undated Dental', 71, `Fits: growing dental group. ${NOTE}`, null, null, daysAgoISO(1))
  const rows = await get(j)
  assert.deepEqual(rows.map(r => r.id), [dated, undated], 'proof-backed timing ranks the dated company first')
  const [a, b] = rows
  assert.equal(a.timing, 'proof_backed'); assert.equal(a.intent, 4)
  assert.equal(b.timing, 'unconfirmed'); assert.equal(b.intent, 0); assert.equal(b.stored_intent, 4, 'stored grade preserved')
  assert.equal(a.fit_rationale, 'Fits: multi-location dental group.')
  assert.equal(b.fit_rationale, 'Fits: growing dental group.', 'the timing note is kept apart from the fit rationale')
  assert.equal(b.currentness_held, true); assert.equal(b.timing_proof_gap, 'timing_unproven')
})

test('without proof, a model or publication date changes nothing: equal-fit twins keep raw-score order', async () => {
  const db = seed(); const j = job(db)
  const modelDated = ins(db, j, 'Model Dated', 70, 'Fits: multi-location dental group.', daysAgoISO(5), null, daysAgoISO(5))
  const undated = ins(db, j, 'No Date', 71, 'Fits: growing dental group.', null, null, null)
  const rows = await get(j)
  assert.deepEqual(rows.map(r => r.id), [undated, modelDated], 'an unproven date does not move the ranking')
  for (const r of rows) { assert.equal(r.intent, 0); assert.equal(r.timing, 'unconfirmed'); assert.ok(r.fit_rationale, 'fit rationale kept') }
})

test('the durable timing-proof record never reaches the Leads payload: only the human timing state does', async () => {
  const db = seed(); const j = job(db)
  const id = ins(db, j, 'Proven Dental', 70, 'Fits: multi-location dental group.', daysAgoISO(5), 'page_bound', null)
  // the current evidence the proof is bound to (#914): an own-domain company site, a named owner and a mailbox published on it
  const site = (kind: string, value: string, url: string, label: string | null = null) => addEnrichment(db, 'A', id, { connector: 'sitecrawl', kind, value, label, confidence: null, source_url: url, source_date: daysAgoISO(0), retrieved_at: Math.floor(Date.now() / 1000) })
  site('domain', 'provendental.test|evidence_own_domain', 'https://provendental.test/news', 'domain-basis-v1:evidence_own_domain')
  site('person', 'Pat, Owner', 'https://provendental.test/team'); site('email', 'pat@provendental.test', 'https://provendental.test/contact')
  addEnrichment(db, 'A', id, { connector: 'scan:actionable', kind: 'actionability', value: 'Actionable: domain, person and published contact confirmed', label: 'Pat, Owner - email: pat@provendental.test', confidence: null, source_url: 'https://invalid.example/', source_date: daysAgoISO(0), retrieved_at: Math.floor(Date.now() / 1000) })
  assert.deepEqual(recordTimingProof(db, { id: j, user_id: 'A' }), { proven: 1, held: 0 })
  const res = await leadsGET(new NextRequest(`http://test/api/leads?job_id=${j}`))
  const body = await res.text()
  const [row] = (JSON.parse(body) as { leads: (Row & { enrichments: { connector: string; kind: string; value: string }[] })[] }).leads
  assert.equal(row.timing_proof_gap, null, 'the proof stands'); assert.equal(row.currentness_held, false)
  assert.ok(row.enrichments.some(e => e.connector === 'scan:actionable'), 'user-facing enrichments are still listed')
  assert.ok(!row.enrichments.some(e => e.kind === 'timing_proof' || e.connector === 'scan:timing-proof'), 'no proof record in the enrichment list')
  assert.doesNotMatch(body, /timing-proof:v|\\"state\\":\\"proven\\"|scan:timing-proof/, 'no raw proof JSON anywhere in the payload')
})
