// #1831 runtime: Home counts ready with homeReady (per-lead rule leadHoldReason) and the header stats read
// previewSplit (lib/journey.ts). The Leads page
// moves a lead to Research when its timing is unconfirmed (the route's surfaceStoredIntent verdict) with no review
// reason, no quarantine and no human confirmation (#1735). A machine-verified lead with NO saved grade (intent null)
// is unconfirmed by that rule ('no_saved_grade') even when its durable timing proof stands — proofBackedTiming never
// reads intent — so every heldReason check passed and Home counted it ready. Both counts must agree for such a lead.
// The fixture follows test/timing-proof-currentness.test.ts's proven-proof recipe.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { setScanDb } from './tenant-route-db.ts'
import { addEnrichment, enrichmentsForLeads } from '../../lib/connectors/store.ts'
import { createJob, listLeads } from '../../lib/scan/store.ts'
import { surfaceStoredIntent, eventDayVerified } from '../../lib/scan/scoreboard.ts'
import { recordTimingProof, timingProofGap } from '../../lib/scan/timing-proof.ts'
import { journey, previewSplit, type PreviewLead } from '../../lib/journey.ts'
import { currentnessHeld, leadWindowHeld } from '../../lib/outreach/currentness.ts'
import { requiredGateHeld } from '../../lib/scan/held-state.ts'
import { leadHoldReason, timingOptsFor } from '../../lib/outreach/lead-hold.ts'
import { homeReady } from '../../lib/outreach/home-ready.ts'
import { ownSiteBuyerRows } from './own-site-buyer.ts'

const T = 'A'
const NOW = Math.floor(Date.now() / 1000)
const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)

function build() {
  const db = new Database(':memory:')
  migrateAllSqlite(db)
  setScanDb(db)
  const jobId = createJob(db, T, { business_name: 'Seller', industry: 'dental', location: 'Austin' })
  db.prepare("UPDATE scan_jobs SET status = 'running', query = ?, icp = ? WHERE id = ?")
    .run('dental groups in Austin that opened a new clinic in the last 30 days', JSON.stringify({ window_days: 30 }), jobId)
  const lead = (id: string, company: string, domain: string, intent: number | null) => {
    db.prepare(`INSERT INTO leads (id, scan_job_id, company, name, contact, signal, source_url, evidence_excerpt, confidence, score, fit, intent, signal_kind, event_date, event_date_proof, company_domain, review_reason, quarantined_at, human_confirmed_at, created_at)
      VALUES (?, ?, ?, 'Dana Lee', ?, 'Opened a second clinic', ?, 'opened its second clinic', 80, 70, 4, ?, 'expansion', ?, 'page_bound', ?, NULL, NULL, NULL, ?)`)
      .run(id, jobId, company, `dana@${domain}`, `https://news.example.test/${id}`, intent, day(5), domain, NOW - 86400)
    for (const r of ownSiteBuyerRows(domain, { name: 'Dana Lee', title: 'Owner' })) addEnrichment(db, T, id, r)
    addEnrichment(db, T, id, { connector: 'sitecrawl', kind: 'email', value: `dana@${domain}`, label: null, confidence: null, source_url: `https://${domain}/contact`, source_date: day(0), retrieved_at: NOW })
    addEnrichment(db, T, id, { connector: 'scan:actionable', kind: 'actionability', value: 'Actionable: domain, person and published contact confirmed', label: `Dana Lee, Owner - email: dana@${domain}`, confidence: null, source_url: 'https://invalid.example/', source_date: day(0), retrieved_at: NOW })
  }
  lead('research', 'Acme Dental', 'acme-dental.test', null)   // no saved grade: timing unconfirmed, proof otherwise standing
  lead('proof', 'Proof Dental', 'proof-dental.test', 4)       // the same, with a saved grade: proof-backed everywhere
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(jobId)
  return { db, jobId }
}

// The Leads page's own Research rule (leads-client): the route's timing verdict plus the row's review/quarantine/
// confirmation fields.
function leadsPageResearch(l: { timing: string; review_reason?: string | null; quarantined_at?: unknown; human_confirmed_at?: number | null }): boolean {
  return l.timing === 'unconfirmed' && !l.review_reason && !l.quarantined_at && l.human_confirmed_at == null
}

test('#1831 a Research lead (no saved grade, timing proof standing) is not counted ready by Home', async () => {
  const { db, jobId } = build()
  recordTimingProof(db, { id: jobId, user_id: T })
  assert.equal(timingProofGap(db, T, 'research'), null, 'the durable timing proof stands for the no-grade lead (it never reads intent)')
  const job = db.prepare('SELECT id, query, icp FROM scan_jobs WHERE id = ?').get(jobId) as { id: string; query: string; icp: string }
  const opts = timingOptsFor(job)
  const rows = listLeads(db, T, jobId, 500, true) as { id: string; intent: number | null; review_reason: string | null; quarantined_at: unknown; human_confirmed_at: number | null }[]
  const enr = enrichmentsForLeads(db, T, rows.map(l => l.id))
  const byId = Object.fromEntries(rows.map(l => [l.id, l]))

  const researchTiming = surfaceStoredIntent(byId.research as never, opts).timing
  assert.equal(researchTiming, 'unconfirmed', 'the route hands the Leads page timing=unconfirmed (no saved grade)')
  assert.equal(leadsPageResearch({ timing: researchTiming, review_reason: byId.research.review_reason, quarantined_at: byId.research.quarantined_at, human_confirmed_at: byId.research.human_confirmed_at }), true, 'the Leads page shows this lead under Research only')
  assert.equal(surfaceStoredIntent(byId.proof as never, opts).timing, 'proof_backed')

  assert.equal(leadHoldReason(db, T, byId.research as never, enr.research ?? [], opts, new Date(NOW * 1000)), 'event timing unknown')
  assert.equal(leadHoldReason(db, T, byId.proof as never, enr.proof ?? [], opts, new Date(NOW * 1000)), null)

  const r = await homeReady(T, NOW)
  assert.equal(r.ready, 1, 'only the proof-backed company counts ready')
  assert.deepEqual(r.companies.filter(c => c.ready).map(c => c.lead_id), ['proof'])
  assert.deepEqual(r.held, [{ reason: 'event timing unknown', count: 1, job_id: jobId, scans: 1 }])

  // The header stats (app/app/journey.tsx) read previewSplit over the leads route's rows — prod showed
  // '2 ready, 0 research' over this same pair. The split must agree with the Leads page too.
  const at = new Date(NOW * 1000)
  const routeRow = (l: (typeof rows)[number]): PreviewLead => {
    const s = surfaceStoredIntent(l as never, opts)
    return { ...l, stored_intent: l.intent ?? null, intent: s.intent, timing: s.timing, enrichments: enr[l.id] ?? [],
      day_verified: eventDayVerified(l as never, { now: at }), window_held: leadWindowHeld(db, T, l.id, at),
      currentness_held: currentnessHeld(db, T, l.id, at), gate_held: requiredGateHeld(db, T, l.id) !== null } as unknown as PreviewLead
  }
  const split = previewSplit([routeRow(byId.research as never), routeRow(byId.proof as never)])
  assert.deepEqual(split.opportunities.map(o => o.id), ['proof'], 'the header counts only the proof-backed lead ready')
  assert.deepEqual(split.research.map(x => x.lead.id), ['research'], 'the header counts the Research lead as research, not ready')
})

test('#1831 a play whose only lead is a Research lead reads research-only on Home, not 0 opportunities', async () => {
  const { db, jobId } = build()
  recordTimingProof(db, { id: jobId, user_id: T })
  const job = db.prepare('SELECT id, query, icp FROM scan_jobs WHERE id = ?').get(jobId) as { id: string; query: string; icp: string }
  const opts = timingOptsFor(job)
  const rows = listLeads(db, T, jobId, 500, true) as { id: string; intent: number | null; review_reason: string | null; quarantined_at: unknown; human_confirmed_at: number | null }[]
  const enr = enrichmentsForLeads(db, T, rows.map(l => l.id))
  const research = rows.find(l => l.id === 'research')!
  const at = new Date(NOW * 1000)
  const s = surfaceStoredIntent(research as never, opts)
  const row = { ...research, stored_intent: research.intent ?? null, intent: s.intent, timing: s.timing, enrichments: enr.research ?? [],
    day_verified: eventDayVerified(research as never, { now: at }), window_held: leadWindowHeld(db, T, research.id, at),
    currentness_held: currentnessHeld(db, T, research.id, at), gate_held: requiredGateHeld(db, T, research.id) !== null } as unknown as PreviewLead
  const split = previewSplit([row])
  assert.deepEqual(split.held.map(h => h.lead.id), ['research'], 'the Research lead is held as well as research, with its timing reason')
  assert.equal(split.held[0].reason, 'event timing unknown')
  const j = journey({ profile: { sells: 'Booking software', website: 'brightsmile.example' }, jobs: [{ id: jobId, status: 'done', error: null, query: job.query, csv_domain: null, created_at: NOW - 86400, candidates: 1, verified: 1, needs_review: 0, dropped: 0, lead_count: 1, test_only: false }], leads: [row], drafts: null })
  assert.equal(j.stage, 'research_only', 'Home shows the research-only state, not the zero-results state')
})

test('#1831 a company-first lead is judged with the run_budget window, not the getJob read that omits it', async () => {
  const db = new Database(':memory:')
  migrateAllSqlite(db)
  setScanDb(db)
  const jobId = createJob(db, T, { business_name: 'Seller', industry: 'dental', location: 'Austin' })
  // A company-first search asking for 'recently' with no numeric window: the saved company-first window is 45 days.
  db.prepare("UPDATE scan_jobs SET status = 'running', query = ?, icp = ?, run_budget = ? WHERE id = ?")
    .run('dental groups in Austin that recently opened a new clinic', JSON.stringify({}), JSON.stringify({ discovery_source: 'company_first_v1' }), jobId)
  db.prepare(`INSERT INTO leads (id, scan_job_id, company, name, contact, signal, source_url, evidence_excerpt, confidence, score, fit, intent, signal_kind, event_date, event_date_proof, company_domain, review_reason, quarantined_at, human_confirmed_at, created_at)
    VALUES ('cf', ?, 'Cf Dental', 'Dana Lee', 'dana@cf-dental.test', 'Opened a second clinic', 'https://news.example.test/cf', 'opened its second clinic', 80, 70, 4, 4, 'expansion', ?, 'page_bound', 'cf-dental.test', NULL, NULL, NULL, ?)`)
    .run(jobId, day(5), NOW - 86400)
  for (const r of ownSiteBuyerRows('cf-dental.test', { name: 'Dana Lee', title: 'Owner' })) addEnrichment(db, T, 'cf', r)
  addEnrichment(db, T, 'cf', { connector: 'sitecrawl', kind: 'email', value: 'dana@cf-dental.test', label: null, confidence: null, source_url: 'https://cf-dental.test/contact', source_date: day(0), retrieved_at: NOW })
  addEnrichment(db, T, 'cf', { connector: 'scan:actionable', kind: 'actionability', value: 'Actionable: domain, person and published contact confirmed', label: 'Dana Lee, Owner - email: dana@cf-dental.test', confidence: null, source_url: 'https://invalid.example/', source_date: day(0), retrieved_at: NOW })
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(jobId)
  recordTimingProof(db, { id: jobId, user_id: T })
  const rows = listLeads(db, T, jobId, 500, true) as { id: string }[]
  const enr = enrichmentsForLeads(db, T, rows.map(l => l.id))
  const lead = rows[0] as never
  // The bug: timing options from a job read without run_budget hold the proof-backed lead (unresolved recency bound).
  const jobNoBudget = db.prepare('SELECT id, query, icp FROM scan_jobs WHERE id = ?').get(jobId) as { id: string; query: string; icp: string }
  assert.equal(leadHoldReason(db, T, lead, enr.cf ?? [], timingOptsFor(jobNoBudget), new Date(NOW * 1000)), 'event timing unknown', 'without run_budget the same lead is wrongly held')
  // With the run_budget the jobs list carries, the saved 45-day company-first window applies and the lead is ready.
  // (homeReady's own verdict for this lead is the company-first gate's 'final checks not finished' - the checks
  // never ran for a fixture lead - so the timing rule is pinned here at the function homeReady calls per lead.)
  const jobWithBudget = db.prepare('SELECT id, query, icp, run_budget FROM scan_jobs WHERE id = ?').get(jobId) as { id: string; query: string; icp: string; run_budget: string }
  assert.equal(timingOptsFor(jobWithBudget).windowDays, 45, 'the company-first window is the saved 45 days')
  assert.equal(leadHoldReason(db, T, lead, enr.cf ?? [], timingOptsFor(jobWithBudget), new Date(NOW * 1000)), null, 'with run_budget the proof-backed lead is ready')
  const homeReadySrc = await import('node:fs').then(fs => fs.readFileSync(new URL('../../lib/outreach/home-ready.ts', import.meta.url), 'utf8'))
  assert.ok(homeReadySrc.includes('run_budget: j.run_budget'), 'homeReady passes the jobs-list run_budget into its timing options')
})
