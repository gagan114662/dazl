// #878: each condition is checked on ITS OWN evidence date. A lead dated by a job board's structured publish day (event_date_proof
// 'ats_structured') has a proven day for that POSTING only: it never dates a raise, an opening or a completed hire that the posting's
// boilerplate mentions. Before this fix a funding condition borrowed the posting's day: a real Clay posting ("In 2026, we raised a $115M
// Series D", a raise reported on 2026-09-09) published 2026-11-10 passed "raised a Series D in the last 30 days" as "evidence dated
// 2026-11-10", and the card said "dated by its own source".
// REAL wording: the public Ashby postings of Clay (claylabs c605042d, published 2026-04-15) and Rillet (rillet 30ac8f73, published
// 2025-12-02), fetched 2026-11-21, quoted verbatim (shortened, the tracking link dropped). The lead row has the shape a scan stores for
// a board-dated hiring lead (event_date_proof 'ats_structured', date_status 'verified'). The days are
// moved next to the test's clock so each one sits inside the window it is checked against. Real store, real writer, no network, no model.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { compileTargeting, evaluatePlan } from '../lib/scan/targeting.ts'
import { planProofs, type ProofLead } from '../lib/scan/targeting-proof.ts'
import { recordActionability } from '../lib/scan/actionable.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateMemory } from '../lib/memory.ts'

const day = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10)
const CLAY = { company: 'Clay', domain: 'clay.com', url: 'https://jobs.ashbyhq.com/claylabs/c605042d-1bd4-4e0d-aa82-d92a2abecb59', signal: 'hiring a Growth Strategist, Enterprise', quote: 'In 2026, we raised a $115M Series D at $7.1B Valuation led by Wellington' }
const RILLET = { company: 'Rillet', domain: 'rillet.com', url: 'https://jobs.ashbyhq.com/rillet/30ac8f73-bd93-43fb-8a17-60e03a98dbff', signal: 'hiring an Accounting Success Manager', quote: 'Rillet has raised more than $200M, is valued at $1B, and is backed by Sequoia, a16z, ICONIQ, Bain Capital Ventures, Oak HC/FT, and other leading investors.' }
const QUERY = 'B2B software companies that raised a Series D in the last 30 days and are hiring sales reps'

function seed(rows: { id: string; c: typeof CLAY; date: string; proof: 'ats_structured' | 'page_bound' }[], query = QUERY) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db); migrateMemory(db)
  const icp = JSON.stringify({ summary: 's', who: ['Founder'], signals: [], exclude: [] })
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ?, query = ? WHERE id = ?").run(icp, query, jobId)
  for (const r of rows) {
    db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url, evidence_excerpt, event_date, event_date_proof, date_status, confidence, score, fit) VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, ?, 'verified', 80, 80, 5)")
      .run(r.id, jobId, r.c.company, r.c.domain, r.c.signal, r.c.url, r.c.quote, r.date, r.proof)
    // the sales-hiring gate's durable pass (it runs before the plan is read; without it the lead is held first)
    for (const v of ['sales_hiring', 'requested_role_v1']) db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES (?, ?, 'u1', 'scan:gate', 'gate_passed', ?, 'x', NULL, 'https://invalid.example/', ?, 1)").run(`${r.id}g${v}`, r.id, v, day(0))
  }
  return { db, job: { id: jobId, user_id: 'u1', query, icp } }
}
const clauses = (db: Database.Database, id: string) => (db.prepare("SELECT value, source_date FROM lead_enrichments WHERE lead_id = ? AND connector = 'scan:targeting' ORDER BY value").all(id) as { value: string; source_date: string }[])
const actionability = (db: Database.Database, id: string) => (db.prepare("SELECT value FROM lead_enrichments WHERE lead_id = ? AND connector = 'scan:actionable'").get(id) as { value: string }).value

test('#878 a job board\'s posting day never dates the raise the posting mentions (real Clay and Rillet postings, the real writer)', () => {
  for (const [c, query, text] of [[CLAY, QUERY, 'raised a Series D in the last 30 days'], [RILLET, 'B2B software companies that raised funding in the last 30 days and are hiring sales reps', 'raised funding in the last 30 days']] as const) {
    const { db, job } = seed([{ id: 'l', c, date: day(c === CLAY ? 11 : 4), proof: 'ats_structured' }], query)
    const y = recordActionability(db, job)
    const [c1] = clauses(db, 'l')
    assert.equal(c1.value, `C1 ${text}: unknown, no evidence date`, c.company)
    assert.equal(c1.source_date, day(0), 'the check day, never the posting day as evidence')
    assert.match(actionability(db, 'l'), /targeting not proven/)
    assert.deepEqual(y.leads[0].missing, ['targeting_not_proven'])
  }
})

test('#878 the same raise dated on its own page (page_bound) is still proven and stored with that day', () => {
  const { db, job } = seed([{ id: 'clay', c: CLAY, date: day(11), proof: 'page_bound' }])
  recordActionability(db, job)
  const [c1] = clauses(db, 'clay')
  assert.equal(c1.value, `C1 raised a Series D in the last 30 days: pass, evidence dated ${day(11)}`)
  assert.equal(c1.source_date, day(11))
})

test('#878 a board-dated posting still dates its own hiring condition; the raise beside it in the same quote is not dated by it', () => {
  // the quote joins a hiring sentence (shape of a posting's opening line) to Clay's real raise sentence
  const q = 'B2B software companies hiring account executives in the last 30 days that raised a Series D in the last 90 days'
  const plan = compileTargeting(q)
  const lead: ProofLead = { company: CLAY.company, company_domain: CLAY.domain, evidence_excerpt: `Clay is hiring Account Executives to join our sales team. ${CLAY.quote}`, signal: 'hiring Account Executives', source_url: CLAY.url, event_date: day(11), event_date_proof: 'ats_structured' }
  const p = planProofs(plan, lead, [], { query: q, icp: null, salesGatePassed: false, competitors: null, graded: true })
  assert.deepEqual([p.C1.truth, p.C1.date], ['pass', day(11)], 'hiring: the posting day is that condition\'s own evidence date')
  assert.deepEqual([p.C2.truth, p.C2.date], ['unknown', undefined], p.C2.reason)
  assert.match(p.C2.reason, /no date of its own|carries no date/)
  assert.equal(evaluatePlan(plan, p).truth, 'unknown')
  // the same raise on a page that dates it (page_bound) passes on that day
  const own = planProofs(plan, { ...lead, event_date_proof: 'page_bound' }, [], { query: q, icp: null, salesGatePassed: false, competitors: null, graded: true })
  assert.deepEqual([own.C2.truth, own.C2.date], ['pass', day(11)])
})

test('#878 (review) on a board-dated lead: a raise with no clock stays proven without a date; a clock counted from that raise cannot be checked', () => {
  const ctx = { icp: null, salesGatePassed: false, competitors: null, graded: true }
  const lead: ProofLead = { company: CLAY.company, company_domain: CLAY.domain, evidence_excerpt: `Clay is hiring Account Executives to join our sales team. ${CLAY.quote}`, signal: 'hiring Account Executives', source_url: CLAY.url, event_date: day(11), event_date_proof: 'ats_structured' }
  // no window on the raise: nothing to check, so it passes as before, but it never carries the posting day as its date
  const q1 = 'B2B software companies that raised a Series D and are hiring account executives'
  const p1 = planProofs(compileTargeting(q1), lead, [], { ...ctx, query: q1 })
  assert.deepEqual([p1.C1.truth, p1.C1.date], ['pass', undefined], p1.C1.reason)
  // a posting counted from the raise: the raise has no day of its own, so the gap to it cannot be checked (relate refuses it)
  const q2 = 'B2B software companies that raised a Series D and are hiring account executives within 30 days of the raise'
  const plan2 = compileTargeting(q2)
  const posting = [{ connector: 'signals:ashby-gtm', kind: 'hiring', value: 'Account Executive - posted', source_url: 'https://jobs.ashbyhq.com/claylabs/ae', source_date: day(5) }]
  const p2 = planProofs(plan2, lead, posting, { ...ctx, query: q2 })
  assert.deepEqual([p2.C1.truth, p2.C1.date], ['pass', undefined], p2.C1.reason)
  assert.equal(p2.C2.truth, 'unknown'); assert.match(p2.C2.reason, /not dated on separate sources/)
  assert.equal(evaluatePlan(plan2, p2).truth, 'unknown')
  // control: the raise dated on its own page, the posting 6 days later on another source: the gap is checked and passes
  const own = planProofs(plan2, { ...lead, event_date_proof: 'page_bound' }, posting, { ...ctx, query: q2 })
  assert.equal(own.C2.truth, 'pass'); assert.match(own.C2.reason, /6 days after C1/)
})

test('#878 (review) an opening or a completed hire mentioned on a board-dated posting is not dated by the posting either', () => {
  const ctx = { icp: null, salesGatePassed: false, competitors: null, graded: true }
  const posting = (quote: string): ProofLead => ({ company: 'Clay', company_domain: CLAY.domain, evidence_excerpt: quote, signal: 'hiring Account Executives', source_url: CLAY.url, event_date: day(11), event_date_proof: 'ats_structured' })
  for (const [q, quote] of [
    ['B2B software companies that opened a new office in the last 30 days', 'Clay opened a new office in New York.'],
    ['B2B software companies that made their first sales hire in the last 30 days', 'Clay made its first sales hire.'],
  ] as const) {
    const plan = compileTargeting(q)
    const board = planProofs(plan, posting(quote), [], { ...ctx, query: q })
    const own = planProofs(plan, { ...posting(quote), event_date_proof: 'page_bound' }, [], { ...ctx, query: q })
    assert.deepEqual([own.C1.truth, own.C1.date], ['pass', day(11)], `control, dated on its own page: ${own.C1.reason}`)
    assert.deepEqual([board.C1.truth, board.C1.date], ['unknown', undefined], `${q}: ${board.C1.reason}`)
    assert.match(board.C1.reason, /no date of its own/)
  }
})
