// Qodo review of #1509 (#1122), Mediums 6-8: a trailing "hire" noun on a new-role title (M6), new-role branches on their own clock at the
// sales-hiring gate (M7), and an OR with more than one event branch (M8). The real planner, the real gate and an in-memory store; the posting
// rows are case-1 rows from b9a34d2d (Uare.ai's Greenhouse Head of Sales posting, first published 2026-10-20). No network (boards 404).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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

interface Lead { company: string; url: string; signal: string; excerpt: string; date: string | null; proof: string | null; domain?: string }
async function gate(query: string, l: Lead, titles: [string, string][] = [], fetchImpl: typeof fetch = noFetch) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running', query = ?, icp = NULL WHERE id = ?").run(query, jobId)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url, evidence_excerpt, confidence, score, why, event_date, event_date_proof, date_status) VALUES ('L1', ?, '', ?, ?, ?, ?, ?, 80, 80, '', ?, ?, 'verified')")
    .run(jobId, l.company, l.domain ?? null, l.signal, l.url, l.excerpt, l.date, l.proof)
  if (l.domain) db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES ('D1', 'L1', 'u1', 'sitecrawl', 'domain', ?, 'x', NULL, ?, '2026-11-01', 1)").run(`${l.domain}|evidence_own_domain`, `https://${l.domain}/`)
  db.prepare("UPDATE scan_jobs SET status = 'done', verified = 1, needs_review = 0 WHERE id = ?").run(jobId)
  await applySalesHiringGate(db, { id: jobId, user_id: 'u1', query, icp: null }, fetchImpl, { now: NOW, postingTitles: new Map(titles.map(([u, t]) => [postingKey(u)!, t])) })
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

test('Qodo #1522 H1/H2: each event branch is read as itself: a dated launch proves the launch branch; an unrequested event proves nothing', async () => {
  const Q = 'Find B2B companies that raised seed funding, launched a product, or are hiring an SDR, in the last 45 days.'
  const launch = { company: 'Synthco', url: 'https://synthco.example/news/1', signal: 'Synthco launched a product', excerpt: 'Synthco today launched its new product, an analytics suite for finance teams.', date: day(20), proof: 'page_bound' }
  assert.equal(await gate(Q, launch), null, 'only the non-funding branch has dated proof')
  const Q2 = 'Find B2B companies that opened an office within 7 days, launched a product within 90 days, or are hiring an SDR.'
  const office = { company: 'Synthco', url: 'https://synthco.example/news/2', signal: 'Synthco opened an office', excerpt: 'Synthco opened a new office in Austin.', date: day(30), proof: 'page_bound' }
  assert.equal(await gate(Q2, office), 'no_sales_hiring_evidence', 'an office opening 30 days ago is outside its 7 days and is not a product launch')
  assert.equal(await gate(Q2, { ...office, date: day(3) }), null, 'inside its own 7 days it proves its own branch')
})

test('Qodo #1522 M4: company-first discovery takes the funding pass when any event branch is funding', () => {
  const or = salesGateOr('Find B2B companies that launched a product, raised seed funding, or are hiring an SDR, in the last 45 days.', null)
  assert.ok(or); assert.equal(or!.event.kind, 'event', 'the launch is listed first')
  assert.ok((or!.events ?? [or!.event]).some(e => e.kind === 'funding'))
  const src = readFileSync(new URL('../lib/scan/runner.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /salesGateOr\([^)]*\)\)?\?\.event\.kind === 'funding'/, 'the funding pass is not chosen from the first event alone')
})

test('Qodo #1522 M3: a requested new-role posting found by the board lookup keeps its own clock; another title keeps the hiring clock', async () => {
  const Q = 'companies hiring their first SDR within 30 days or a new Head of Sales within 90 days or new funding within 30 days'
  const GH = 'https://boards-api.greenhouse.io/v1/boards/brightloop'
  const board = (title: string, ageDays: number) => (async (u: RequestInfo | URL) => {
    const m: Record<string, unknown> = {
      [`${GH}/jobs`]: { jobs: [{ id: 1, title }] },
      [`${GH}/jobs/1`]: { id: 1, title, first_published: new Date(NOW - ageDays * 86_400_000).toISOString(), absolute_url: 'https://boards.greenhouse.io/brightloop/jobs/1', location: { name: 'Remote' }, content: '&lt;p&gt;Brightloop is hiring. Write to jobs@brightloop.io&lt;/p&gt;' },
    }
    return m[String(u)] ? new Response(JSON.stringify(m[String(u)]), { status: 200 }) : new Response('nope', { status: 404 })
  }) as never
  // the lead cites its own site, not the posting
  const lead = { company: 'Brightloop', domain: 'brightloop.io', url: 'https://brightloop.io/about', signal: 'Brightloop is growing its sales team', excerpt: 'Brightloop is a B2B platform for finance teams.', date: null, proof: null }
  assert.equal(await gate(Q, lead, [], board('Head of Sales', 60)), null, 'a 60-day-old Head of Sales posting: inside its own 90 days')
  assert.equal(await gate(Q, lead, [], board('Head of Sales', 120)), 'no_sales_hiring_evidence', 'older than its own clock')
  assert.equal(await gate(Q, lead, [], board('Sales Development Representative', 60)), 'no_sales_hiring_evidence', 'an SDR posting keeps the 30-day clock')
})

test('Qodo #1522 (2nd pass) 1: an expansion by the lead and a launch by another company in one excerpt never prove the launch branch', async () => {
  const Q = 'Find B2B companies that raised seed funding, launched a product, or are hiring an SDR, in the last 45 days.'
  const mixed = { company: 'Acme', url: 'https://acme.example/news/1', signal: 'Acme expanded', excerpt: 'Acme expanded into Paris. RivalCo launched a product for finance teams.', date: day(10), proof: 'page_bound' }
  assert.equal(await gate(Q, mixed), 'no_sales_hiring_evidence')
  assert.equal(await gate(Q, { ...mixed, excerpt: 'Acme expanded into Paris. Acme today launched its new product for finance teams.' }), null, 'the lead launching in its own clause still proves it')
})

test('Qodo #1522 (2nd pass) 2: a title matching overlapping requested roles is fresh on the longest of their clocks', async () => {
  const Q = 'companies hiring a new Account Executive within 30 days or a new Enterprise Account Executive within 90 days or new funding within 30 days'
  const GH = 'https://boards-api.greenhouse.io/v1/boards/brightloop'
  const board = (title: string, ageDays: number) => (async (u: RequestInfo | URL) => {
    const m: Record<string, unknown> = {
      [`${GH}/jobs`]: { jobs: [{ id: 1, title }] },
      [`${GH}/jobs/1`]: { id: 1, title, first_published: new Date(NOW - ageDays * 86_400_000).toISOString(), absolute_url: 'https://boards.greenhouse.io/brightloop/jobs/1', location: { name: 'Remote' }, content: '&lt;p&gt;Brightloop is hiring. Write to jobs@brightloop.io&lt;/p&gt;' },
    }
    return m[String(u)] ? new Response(JSON.stringify(m[String(u)]), { status: 200 }) : new Response('nope', { status: 404 })
  }) as never
  const lead = { company: 'Brightloop', domain: 'brightloop.io', url: 'https://brightloop.io/about', signal: 'Brightloop is growing its sales team', excerpt: 'Brightloop is a B2B platform for finance teams.', date: null, proof: null }
  assert.equal(await gate(Q, lead, [], board('Enterprise Account Executive', 45)), null, '45 days: inside the Enterprise AE branch\'s 90 days')
  assert.equal(await gate(Q, lead, [], board('Account Executive', 45)), 'no_sales_hiring_evidence', 'a plain AE posting keeps the 30-day clock')
})

test('Qodo #1522 (2nd pass) 3: a stage-free funding branch never inherits another branch\'s stage', async () => {
  const Q = 'Find B2B companies that raised funding within 45 days, raised a Series A, or are hiring an SDR.'
  const raise = { company: 'Synthco', url: 'https://synthco.example/news/3', signal: 'Synthco raised a seed round', excerpt: 'Synthco raised a $4M seed round led by Example Ventures.', date: day(10), proof: 'page_bound' }
  assert.equal(await gate(Q, raise), null, 'a dated seed raise meets the generic funding branch')
})

test('Qodo #1522 (2nd pass) 4: a stale title is audited on the clock it was judged on, never the wider board window', async () => {
  const { checkedAuditRows, checkedCoverageRow } = await import('../lib/signals/ats-gtm.ts')
  const c = { board: 'ashby', boardUrl: 'https://jobs.ashbyhq.com/x', allTitles: ['Account Executive'], listedCount: 1, titleFilter: 'roles', via: 'domain', domain: 'x.io', rawTotal: 1, rawDatedStale: 1, rawUnread: 0, rawFreshExcluded: 0, datedStale: ['account executive'], staleDays: { 'account executive': 30 } } as never
  const [row] = checkedAuditRows(c, 90, 1, '2026-11-21', null)
  assert.match(row.label, /older than the last 30 days/); assert.doesNotMatch(row.label, /90 days/)
  const cov = checkedCoverageRow(c, 90, 1, '2026-11-21')
  assert.doesNotMatch(cov.label + cov.value, /last 90 days/)
})
