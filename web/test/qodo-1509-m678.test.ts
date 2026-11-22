// Qodo review of #1509 (#1122), Mediums 6-8: a trailing "hire" noun on a new-role title (M6), new-role branches on their own clock at the
// sales-hiring gate (M7), and an OR with more than one event branch (M8). The real planner, the real gate and an in-memory store; the posting
// rows are case-1 rows from b9a34d2d (Uare.ai's Greenhouse Head of Sales posting, first published 2026-10-20). No network (boards 404).
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { compileTargeting, planConditions } from '../lib/scan/targeting.ts'
import { planProofs } from '../lib/scan/targeting-proof.ts'
import { salesGateOr } from '../lib/scan/sales-hiring-required.ts'
import { applySalesHiringGate, postingKey } from '../lib/scan/sales-hiring-gate.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'

const NOW = Date.parse('2026-11-21T12:00:00Z')
const day = (n: number) => new Date(NOW - n * 86_400_000).toISOString().slice(0, 10)
const UARE = 'https://job-boards.greenhouse.io/uareai/jobs/4459513009'
const noFetch = (async () => new Response('nope', { status: 404 })) as never

interface Lead { company: string; url: string; signal: string; excerpt: string; date: string | null; proof: string | null }
async function gate(query: string, l: Lead, titles: [string, string][] = []) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running', query = ?, icp = NULL WHERE id = ?").run(query, jobId)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url, evidence_excerpt, confidence, score, why, event_date, event_date_proof, date_status) VALUES ('L1', ?, '', ?, NULL, ?, ?, ?, 80, 80, '', ?, ?, 'verified')")
    .run(jobId, l.company, l.signal, l.url, l.excerpt, l.date, l.proof)
  db.prepare("UPDATE scan_jobs SET status = 'done', verified = 1, needs_review = 0 WHERE id = ?").run(jobId)
  await applySalesHiringGate(db, { id: jobId, user_id: 'u1', query, icp: null }, noFetch, { now: NOW, postingTitles: new Map(titles.map(([u, t]) => [postingKey(u)!, t])) })
  const r = (db.prepare("SELECT review_reason FROM leads WHERE id = 'L1'").get() as { review_reason: string | null }).review_reason
  db.close(); return r
}
// b9a34d2d, held as no_sales_hiring_evidence: Uare.ai's own board-dated Head of Sales posting.
const uarePosting = (date: string | null, proof: string | null = 'ats_structured'): Lead => ({ company: 'Uare.ai', url: UARE, signal: 'Uare.ai is hiring a Head of Sales', excerpt: 'Uare.ai is hiring a Head of Sales.', date, proof })

test('M6: "a new VP of Sales hire" names the role VP of Sales; a dated posting and a page-bound joined quote both prove it', () => {
  const Q = 'Find B2B companies with a new VP of Sales hire in the last 45 days, or new funding.'
  const plan = compileTargeting(Q, null)
  const c = planConditions(plan.root).find(x => x.cond.kind === 'hire_made')!.cond
  assert.equal(c.role, 'VP of Sales')
  const ctx = { query: Q, icp: null, salesGatePassed: false, competitors: null, now: NOW }
  const lead = (o: Record<string, unknown> = {}) => ({ company: 'Uare.ai', company_domain: null, evidence_excerpt: '', signal: null, source_url: 'https://uare.ai/x', event_date: null, event_date_proof: null, ...o })
  const posting = { connector: 'signals:greenhouse-gtm', kind: 'hiring', value: 'VP of Sales - posted 2026-11-10', source_url: UARE, source_date: '2026-11-10', label: null }
  assert.equal(planProofs(plan, lead(), [posting], ctx)[c.id].truth, 'pass', 'a dated VP of Sales posting')
  assert.equal(planProofs(plan, lead({ evidence_excerpt: 'Uare.ai hired Dana Lee as its new VP of Sales.', event_date: '2026-11-10', event_date_proof: 'page_bound' }), [], ctx)[c.id].truth, 'pass', 'a joined quote')
  assert.notEqual(planProofs(plan, lead({ evidence_excerpt: 'Uare.ai hired Dana Lee as its new VP of Sales.', event_date: '2026-11-10', event_date_proof: null }), [], ctx)[c.id].truth, 'pass', 'still needs a bound date')
  // the open-role reading keeps its precedence, and a hire noun alone is no role
  assert.deepEqual(planConditions(compileTargeting('companies hiring new account executives').root).map(x => x.cond.kind), ['hiring'])
  assert.deepEqual(planConditions(compileTargeting('companies with a new hire').root).map(x => x.cond.kind), [])
})

test('M7: a new-role branch is checked on its own clock at the gate, never the open-hiring clock', async () => {
  const Q = 'companies hiring their first SDR within 30 days or a new Head of Sales within 90 days or new funding within 30 days'
  // Uare.ai's Head of Sales posting, 32 days old: outside the SDR branch's 30 days, inside the Head of Sales branch's 90.
  assert.equal(await gate(Q, uarePosting('2026-10-20'), [[UARE, 'Head of Sales']]), null, 'kept on its own 90-day clock')
  // strict: older than its own clock, undated, or not board-dated is still held
  assert.equal(await gate(Q, uarePosting(day(120)), [[UARE, 'Head of Sales']]), 'no_sales_hiring_evidence')
  assert.equal(await gate(Q, uarePosting(null, null), [[UARE, 'Head of Sales']]), 'no_sales_hiring_evidence')
  // an SDR posting of the same age is held: the SDR branch keeps its 30 days
  assert.equal(await gate(Q, { ...uarePosting('2026-10-20'), signal: 'Uare.ai is hiring an SDR', excerpt: 'Uare.ai is hiring an SDR.' }, [[UARE, 'Sales Development Representative (SDR)']]), 'no_sales_hiring_evidence')
  // a joined quote, page-bound, 60 days old: the Head of Sales branch's clock
  const joined = { company: 'Uare.ai', url: 'https://uare.ai/news/1', signal: 'Uare.ai hired a Head of Sales', excerpt: 'Uare.ai hired Dana Lee as its new Head of Sales.', date: day(60), proof: 'page_bound' }
  assert.equal(await gate(Q, joined), null)
  assert.equal(await gate(Q, { ...joined, date: day(100) }), 'no_sales_hiring_evidence')
})

test('M8: an OR with two event branches and a hiring branch keeps its OR; a lead proving one event alone is kept', async () => {
  const Q = 'Find B2B companies that raised seed funding, launched a product, or are hiring an SDR, in the last 45 days.'
  const or = salesGateOr(Q, null)
  assert.ok(or, 'event / event / hiring is one OR')
  assert.deepEqual(or!.events!.map(e => e.kind).sort(), ['event', 'funding'])
  const seed = { company: 'Synthco', url: 'https://news.example/1', signal: 'Synthco raised a seed round', excerpt: 'Synthco, a B2B SaaS startup, raised a $3m seed round led by Example Ventures.', date: day(20), proof: 'page_bound' }
  assert.equal(await gate(Q, seed), null, 'one event, inside its clock, is enough')
  // strict: the same event outside its clock or with no date, with no hiring proof, is held
  assert.equal(await gate(Q, { ...seed, date: day(80) }), 'no_sales_hiring_evidence')
  assert.equal(await gate(Q, { ...seed, date: null, proof: null }), 'no_sales_hiring_evidence')
})
