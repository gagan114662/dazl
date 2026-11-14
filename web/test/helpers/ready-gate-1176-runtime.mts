// #1176: a lead whose posting day is structurally proven (the job board's own publish day, event_date_proof 'ats_structured') must be
// releasable to Ready on Home, the Leads page's split and the proof preview. Nothing here writes leads.date_status by hand: the lead comes
// out of the real runJob (the real page read of a real Greenhouse record, served through a faked socket; stubbed model and search), the
// user's own "I checked the source - use it" action is the real confirmLeadReview, and the verdicts come from the real handlers.
// Posting: the public Greenhouse record of Flexport's Account Executive, Enterprise (flexport/jobs/8383190), read 2026-11-13.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import https from 'node:https'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { runFixture, daysAgo } from './acceptance-harness.ts'
import { fetchPageDetailed, resetBoardMemo } from '../../lib/scan/fetch-page.ts'
import type { SafeGet } from '../../lib/sources/types.ts'
import { confirmLeadReview } from '../../lib/scan/review-confirm.ts'
import { sqliteDb } from '../../lib/db/client.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { heldReason, previewSplit, type PreviewLead } from '../../lib/journey.ts'
import { buildProofPreview, loadProofInput } from '../../lib/scan/proof-preview.ts'
import { GET as leadsGET } from '../../app/api/leads/route.ts'
import { GET as readyGET } from '../../app/api/home/ready/route.ts'

const REQUEST = 'Find logistics and supply chain software companies that posted a new job in the past 90 days.'
const GH = 'https://job-boards.greenhouse.io/flexport/jobs/8383190'
const SIGNAL = 'Flexport is hiring an Account Executive for Enterprise'
const QUOTE = 'The Enterprise Account Executive (ENT) is responsible for driving complex, high-value enterprise deals'
const ICP = { summary: 'Logistics and supply chain software companies with a new job posting', who: ['Operations leader'], industries: ['Logistics software', 'Supply chain software'], sizes: [], where: [], signals: ['posted a new job'], exclude: [], country: 'US', language: 'en' }
const record = (published: string) => ({
  absolute_url: GH, id: 8383190, internal_job_id: 3618280, requisition_id: 'P-12539', title: 'Account Executive, Enterprise ', company_name: 'Flexport', language: 'en',
  location: { name: 'London, England' }, first_published: `${published}T12:34:11-05:00`, updated_at: `${published}T12:34:11-05:00`,
  departments: [{ id: 12334, name: 'Sales' }], offices: [{ id: 67638, name: 'London', location: 'London, England' }],
  content: '&lt;p&gt;Ready to tackle global challenges that impact business, society, and the environment? Come join us.&lt;/p&gt;&lt;p&gt;&lt;strong&gt;The opportunity:&lt;/strong&gt;&lt;/p&gt;&lt;p&gt;The Enterprise Account Executive (ENT) is responsible for driving complex, high-value enterprise deals and establishing long-term strategic partnerships with large customers. This role owns advanced, multi-stakeholder sales cycles that often span regions, business units, and decision layers. The ENT AE operates with a high degree of autonomy, shaping deal strategy, influencing executive stakeholders, and orchestrating cross-functional teams to deliver differentiated, value-driven solutions.&lt;/p&gt;',
})
function fakeHttps(serve: (url: string) => { status: number; type: string; body: string }) {
  const real = https.request
  resetBoardMemo()
  ;(https as { request: unknown }).request = (url: URL, _o: unknown, cb: (res: EventEmitter) => void) => {
    const req = new EventEmitter() as EventEmitter & { end(): void; destroy(): void }
    req.destroy = () => {}
    req.end = () => { const r = serve(String(url)); const res = Object.assign(new EventEmitter(), { statusCode: r.status, headers: { 'content-type': r.type }, resume() {}, destroy() {} }); cb(res); res.emit('data', Buffer.from(r.body)); res.emit('end') }
    return req
  }
  return () => { (https as { request: unknown }).request = real }
}

async function scan() {
  const published = daysAgo(1)
  const restore = fakeHttps(u => u.startsWith('https://boards-api.greenhouse.io/v1/boards/flexport/jobs/8383190') ? { status: 200, type: 'application/json', body: JSON.stringify(record(published)) } : { status: 404, type: 'text/html', body: '' })
  try {
    const x = await runFixture({
      request: REQUEST, reviewedIcp: ICP, icpReviewed: true, modelIcp: ICP, modelQueries: ['logistics software company job posting'],
      hits: [{ url: GH, title: 'Account Executive, Enterprise - Flexport', snippet: QUOTE, date: null }], tfPages: {}, own: {},
      extraction: [{ company: 'Flexport', signal: SIGNAL, source_url: GH, excerpt: QUOTE, event_date: null }],
      deps: { fetchPage: (u: string) => fetchPageDetailed(u, async () => null), sourceHttp: (async () => null) as SafeGet },
    })
    migrateAllSqlite(x.db)   // the rest of the app's tables (the harness migrates only what a scan needs); idempotent
    return { x, published }
  } finally { restore() }
}
const leadRow = (db: import('better-sqlite3').Database) => db.prepare('SELECT id, scan_job_id, company, event_date, event_date_proof, date_status, review_reason, confidence FROM leads').get() as { id: string; scan_job_id: string; company: string; event_date: string | null; event_date_proof: string | null; date_status: string | null; review_reason: string | null; confidence: number | null }
const apiLeads = async (job: string) => (await (await leadsGET(new NextRequest(`http://test/api/leads?job_id=${job}`))).json() as { leads: (PreviewLead & { company: string })[] }).leads

test('#1176 a structurally proven posting day: the real scan stores the proof, the user confirms the source, and the lead is READY on the Leads split, on Home and in the proof preview', async () => {
  const { x, published } = await scan()
  const row = leadRow(x.db)
  // what the scanner really stored: a proven day in the PROOF column, and never the retired 'verified' status
  assert.deepEqual([row.company, row.event_date, row.event_date_proof, row.review_reason], ['Flexport', published, 'ats_structured', null], JSON.stringify(row))
  assert.notEqual(row.date_status, 'verified')
  assert.notEqual(row.confidence, null)
  setScanDb(x.db); setUser({ id: 'A', business_name: 'Acme' })

  // 1. as the scan left it: the card's own rule says the day is proven, and the gate still holds the lead for what it must (timing proof)
  let [l] = await apiLeads(row.scan_job_id)
  assert.equal((l as { day_verified?: boolean }).day_verified, true, 'the lead card says: verified on the cited source')
  assert.equal(heldReason(l), 'event timing unknown', 'a machine-verified lead without a full timing proof stays held: the strict gate is unchanged')
  assert.equal(previewSplit([l]).opportunities.length, 0)
  // the prospect-facing preview shows a signal with no person and no contact, so it does not (cannot) require the timing proof that needs a named
  // person and a published route; it applies the day proof, the required check's verdict and the run's window
  const asScanned = await loadProofInput(sqliteDb(x.db), 'A', row.scan_job_id, { inferredOffer: { text: 'Deal desk software', sourceUrl: 'https://prospect-clinicsoft.test/about' }, spendUsd: null })
  assert.equal(buildProofPreview(asScanned!).status, 'ready')

  // 2. the user opens the source and uses it (the product's own button): ONLY the date gate was left, and it no longer blocks
  assert.equal(await confirmLeadReview(sqliteDb(x.db), 'A', row.id), true)
  ;[l] = await apiLeads(row.scan_job_id)
  assert.equal(heldReason(l), null, `Flexport must be releasable to Ready, held for: ${heldReason(l)}`)
  assert.deepEqual(previewSplit([l]).opportunities.map(o => o.company), ['Flexport'])
  assert.equal(previewSplit([l]).research.length, 0)

  // 3. Home's Ready tile, the real handler on the same store
  const home = await (await readyGET(new NextRequest('http://test/api/home/ready'))).json() as { ready: number; judged: number; held: { reason: string }[] }
  assert.deepEqual([home.ready, home.judged, home.held], [1, 1, []], JSON.stringify(home))

  // 4. the prospect-facing proof preview is built from the same lead (the day is proven, inside the evidence window)
  const input = await loadProofInput(sqliteDb(x.db), 'A', row.scan_job_id, { inferredOffer: { text: 'Deal desk software', sourceUrl: 'https://prospect-clinicsoft.test/about' }, spendUsd: null })
  assert.ok(input)
  const preview = buildProofPreview(input!)
  assert.equal(preview.status, 'ready', JSON.stringify(preview))
  assert.deepEqual(preview.status === 'ready' ? preview.companies.map(c => c.company) : [], ['Flexport'])
})

test('#1176 controls: the retired verdict without proof and a lead with no day never become ready, with or without the user\'s confirmation', async () => {
  const { x } = await scan()
  const row = leadRow(x.db)
  setScanDb(x.db); setUser({ id: 'A', business_name: 'Acme' })
  const db = sqliteDb(x.db)
  // (a) a row from before 2026-10-23: date_status 'verified', no proof. Hand-written ON PURPOSE: this is the negative control.
  x.db.prepare("UPDATE leads SET event_date_proof = NULL, event_date_proof_note = NULL, date_status = 'verified' WHERE id = ?").run(row.id)
  assert.equal(await confirmLeadReview(db, 'A', row.id), true)
  let [l] = await apiLeads(row.scan_job_id)
  assert.equal((l as { day_verified?: boolean }).day_verified, false)
  assert.equal(heldReason(l), 'no verified date', 'the retired verdict does not count')
  const home = await (await readyGET(new NextRequest('http://test/api/home/ready'))).json() as { ready: number; held: { reason: string }[] }
  assert.equal(home.ready, 0); assert.ok(home.held.some(h => h.reason === 'no verified date'), JSON.stringify(home.held))
  assert.equal(buildProofPreview((await loadProofInput(db, 'A', row.scan_job_id, { inferredOffer: { text: 'Deal desk software', sourceUrl: 'https://prospect-clinicsoft.test/about' }, spendUsd: null }))!).status, 'hold')
  // (b) a lead with a recognised proof but NO event day at all: held for the day itself, whatever else is true of it
  x.db.prepare("UPDATE leads SET event_date = NULL, date_status = 'undated', event_date_proof = 'ats_structured' WHERE id = ?").run(row.id)
  ;[l] = await apiLeads(row.scan_job_id)
  assert.equal((l as { day_verified?: boolean }).day_verified, false)
  assert.notEqual(heldReason(l), null)
  assert.equal(previewSplit([l]).opportunities.length, 0)
})
