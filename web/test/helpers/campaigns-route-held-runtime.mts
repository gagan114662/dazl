// #1062 route-runtime proof (real GET /api/campaigns and GET /api/leads handlers on one real SQLite store, stubbed session,
// no network). Prod, 2026-11-21: a finished company-first scan whose 2 leads were both held by its final checks. /api/leads
// (and the run page, the CSV) showed leads: [] with both in held[], while the Campaigns list and the Leads page's Past scans
// said "Check 1 lead that needs your review" and linked to that empty page. Every count must use the same gate: a held lead
// is never "needs your review" anywhere.
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
import { migrateConnectors } from '../../lib/connectors/store.ts'
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
import { markCompanyFirstBudget } from '../../lib/company-first/product-discovery.ts'
import { beginEnrichment } from '../../lib/scan/enrichment.ts'
import { GET as leadsGET } from '../../app/api/leads/route.ts'
import { GET as campaignsGET } from '../../app/api/campaigns/route.ts'

globalThis.fetch = (async () => { throw new Error('Unexpected network call') }) as typeof fetch

type Card = { id: string; qualification: { needsReview: number; research: number; sourceChecked: number; confirmedByYou: number; unverified: number }; next: { label: string; href: string | null }; run: { tag: string; label: string } | null }

test('GET /api/campaigns (list and history): leads held by a company-first scan\'s checks are never "needs your review"', async () => {
  const db = new Database(':memory:')
  for (const m of [migrateScan, migrateSourceReview, migrateWatch, migrateKeys, migratePlans, migrateConnectors, migrateAdvanced, migrateBilling, migrateOutreach, migrateAutopilot, migrateLedger, migrateReplies, migrateThreadReplies, migrateSequences, migrateTrial, migrateCompetitors, migrateEvents, migrateWarm, migrateSeo, migrateMonitors, migrateCsv, migrateCommenterImport, migrateMemory, migrateReopen]) m(db)
  setScanDb(db)
  setUser({ id: 'A', business_name: 'Acme' })
  // event_date: 10 days ago, inside the 45-day company-first window, so the time window alone does not hold it.
  const recent = new Date(Date.now() - 10 * 86400_000).toISOString().slice(0, 10)
  const lead = (job: string, company: string, review: string | null) => {
    const id = randomBytes(12).toString('hex')
    db.prepare("INSERT INTO leads(id,scan_job_id,company,name,contact,signal,source_url,evidence_excerpt,confidence,score,review_reason,event_date) VALUES(?,?,?,'Pat','pat@held.test','Raised a Series A','https://held.example/a',NULL,NULL,70,?,?)").run(id, job, company, review, recent)
    return id
  }
  const finish = (job: string, budget: string | null, n: number, query: string) =>
    db.prepare("UPDATE scan_jobs SET status='done',enrich_finished_at=1,candidates=?,verified=0,needs_review=?,dropped=0,run_budget=?,query=? WHERE id=?").run(n, n, budget, query, job)

  // The prod shape: a company-first scan, finished, 2 leads, both held by its final checks; one with a reason a person could otherwise review.
  const cf = createJob(db, 'A', { business_name: 'Synthetic A', industry: 'software', location: 'London' })
  db.prepare("UPDATE scan_jobs SET status='running' WHERE id=?").run(cf)
  // + one with no stored reason (its hold must not be given a made-up cause), and one the user rejected (rejected, never held).
  const held = [lead(cf, 'Held Review Co', 'quote_unconfirmed'), lead(cf, 'Held Gate Co', 'no_sales_hiring_evidence'), lead(cf, 'Held Plain Co', null)]
  const rejectedLead = lead(cf, 'Rejected Co', 'quote_unconfirmed')
  db.prepare('UPDATE leads SET quarantined_at = 1 WHERE id = ?').run(rejectedLead)
  finish(cf, markCompanyFirstBudget(null), 4, 'Find London software companies that raised a Series A round.')
  // Control: an ordinary (not company-first) scan whose one lead is in the review list still asks for that review.
  const plain = createJob(db, 'A', { business_name: 'Synthetic A', industry: 'software', location: 'London' })
  db.prepare("UPDATE scan_jobs SET status='running' WHERE id=?").run(plain)
  lead(plain, 'Review Co', 'quote_unconfirmed')
  finish(plain, null, 1, 'Find London software companies that raised a seed round.')

  // A company-first scan marked done whose enrichment is still running: its final checks have not run, so nothing is "held by checks" yet
  // (Qodo review on #1466) - and nothing is reviewable either.
  const enriching = createJob(db, 'A', { business_name: 'Synthetic A', industry: 'software', location: 'London' })
  db.prepare("UPDATE scan_jobs SET status='running' WHERE id=?").run(enriching)
  lead(enriching, 'Pending Co', 'quote_unconfirmed')
  finish(enriching, markCompanyFirstBudget(null), 1, 'Find London software companies that raised a Series A round.')
  db.prepare('UPDATE scan_jobs SET enrich_started_at = ?, enrich_finished_at = NULL WHERE id = ?').run(Math.floor(Date.now() / 1000) - 60, enriching)
  const pending = await (await leadsGET(new NextRequest(`http://localhost/api/leads?job_id=${enriching}`))).json() as { leads: unknown[]; held: unknown[] }
  assert.deepEqual([pending.leads, pending.held], [[], []], 'enriching: no lead shown and none listed as held yet')

  // A company-first scan that failed keeps its own "Search failed" step (sonnet, round 3), and nothing in it is reviewable.
  const failed = createJob(db, 'A', { business_name: 'Synthetic A', industry: 'software', location: 'London' })
  db.prepare("UPDATE scan_jobs SET status='running' WHERE id=?").run(failed)
  lead(failed, 'Failed Co', 'quote_unconfirmed')
  db.prepare("UPDATE scan_jobs SET status='failed',error='provider error',run_budget=?,query=? WHERE id=?").run(markCompanyFirstBudget(null), 'Find London software companies that raised a Series A round.', failed)

  const leadsRes = await leadsGET(new NextRequest(`http://localhost/api/leads?job_id=${cf}`))
  assert.equal(leadsRes.status, 200)
  const leadsBody = await leadsRes.json() as { leads: { id: string }[]; held: { id: string; hold_reason: string }[] }
  assert.deepEqual(leadsBody.leads, [], 'the run page lists no reviewable lead')
  assert.deepEqual(leadsBody.held.map(h => h.id).sort(), [...held].sort(), 'the held leads are shown read-only as held; the rejected one is not')
  assert.equal(leadsBody.held.find(h => h.id === held[2])?.hold_reason, 'held_by_final_checks', 'no stored reason: no specific check is claimed')

  for (const url of ['http://localhost/api/campaigns', 'http://localhost/api/campaigns?view=history']) {
    const res = await campaignsGET(new NextRequest(url))
    assert.equal(res.status, 200, url)
    const cards = (await res.json() as { campaigns: Card[] }).campaigns
    const c = cards.find(x => x.id === cf)
    assert.ok(c, `${url}: the company-first scan is listed`)
    assert.equal(c.qualification.needsReview, 0, `${url}: a held lead is never counted as needing review`)
    assert.equal(c.qualification.sourceChecked + c.qualification.confirmedByYou + c.qualification.unverified, 0, `${url}: nor as passed or checkable`)
    assert.doesNotMatch(c.next.label, /review/i, `${url}: the next step never asks for a review the run page cannot show (${c.next.label})`)
    // All three live ones would otherwise read reviewable / unverified: each is held by checks, counted once (inside research); the
    // rejected one stays rejected. (A hidden lead the other checks already call research keeps that verdict: company-first-window-campaign.test.ts.)
    assert.equal((c.qualification as { heldByChecks?: number }).heldByChecks, 3, `${url}: held by checks`)
    assert.equal(c.qualification.research, 3, `${url}: research only, held by checks included once`)
    assert.equal((c.qualification as { rejected?: number }).rejected, 1, `${url}: the user's rejection stays a rejection`)
    assert.deepEqual(c.next, { label: '3 leads are held by checks (read-only): open the run to see why', href: `/app/leads?job_id=${cf}` }, `${url}: it points at the run page's read-only held list`)
    assert.doesNotMatch(c.run?.tag ?? '', /review/i, `${url}: nor does the run pill`)
    assert.doesNotMatch(c.run?.label ?? '', /[1-9]\d* needs? your review/, `${url}: nor the run label (${c.run?.label})`)
    const e = cards.find(x => x.id === enriching)
    assert.ok(e, `${url}: the enriching scan is listed`)
    assert.equal(e.qualification.needsReview, 0, `${url}: enriching: nothing to review`)
    assert.equal(e.next.label, 'Search still running', `${url}: enriching: still running, not "held by checks"`)
    const f = cards.find(x => x.id === failed)
    assert.ok(f, `${url}: the failed scan is listed`)
    assert.equal(f.qualification.needsReview, 0, `${url}: failed: nothing to review`)
    assert.doesNotMatch(f.next.label, /still running|review/i, `${url}: failed: never "still running" (${f.next.label})`)
    const p = cards.find(x => x.id === plain)
    assert.ok(p, `${url}: the control scan is listed`)
    assert.equal(p.qualification.needsReview, 1, `${url}: an ordinary review-list lead still needs review`)
    assert.equal(p.next.label, 'Check 1 lead that needs your review', url)
  }
})

// Qodo on #1466 ("Enriching leads can briefly appear held"): GET /api/leads must decide the held list from the SAME snapshot as the visible set.
// Forced interleaving, no mock: better-sqlite3's verbose hook sees the route's own scan_jobs read; right after it, a new enrichment attempt
// starts (the real beginEnrichment, which clears enrich_finished_at). The visibility read that follows sees an unfinished stage: nothing may be
// listed as held from it, whatever the route read a moment earlier.
test('GET /api/leads: an enrichment attempt that starts mid-request never lists every candidate as held', async () => {
  let armed = false
  const db: Database.Database = new Database(':memory:', { verbose: (sql: unknown) => {
    if (armed && /^SELECT run_budget(, enrich_finished_at)? FROM scan_jobs WHERE id = '[^']+' AND user_id = '[^']+'$/.test(String(sql))) {
      armed = false
      queueMicrotask(() => { const a = (db.prepare('SELECT attempts FROM scan_jobs WHERE id = ?').get(job) as { attempts: number }).attempts; beginEnrichment(db, job, a) })
    }
  } })
  for (const m of [migrateScan, migrateSourceReview, migrateWatch, migrateKeys, migratePlans, migrateConnectors, migrateAdvanced, migrateBilling, migrateOutreach, migrateAutopilot, migrateLedger, migrateReplies, migrateThreadReplies, migrateSequences, migrateTrial, migrateCompetitors, migrateEvents, migrateWarm, migrateSeo, migrateMonitors, migrateCsv, migrateCommenterImport, migrateMemory, migrateReopen]) m(db)
  setScanDb(db)
  setUser({ id: 'A', business_name: 'Acme' })
  const job = createJob(db, 'A', { business_name: 'Synthetic A', industry: 'software', location: 'London' })
  db.prepare("UPDATE scan_jobs SET status='running' WHERE id=?").run(job)
  const id = randomBytes(12).toString('hex')
  db.prepare("INSERT INTO leads(id,scan_job_id,company,name,contact,signal,source_url,evidence_excerpt,confidence,score,review_reason) VALUES(?,?,'Held Co','Pat','pat@held.test','Raised a Series A','https://held.example/a',NULL,NULL,70,'quote_unconfirmed')").run(id, job)
  db.prepare("UPDATE scan_jobs SET status='done',enrich_started_at=1,enrich_finished_at=2,candidates=1,dropped=0,run_budget=?,query='Find London software companies that raised a Series A round.' WHERE id=?").run(markCompanyFirstBudget(null), job)
  // control: with the stage finished and nothing moving, the held candidate is listed
  const settled = await (await leadsGET(new NextRequest(`http://localhost/api/leads?job_id=${job}`))).json() as { leads: unknown[]; held: { id: string }[] }
  assert.deepEqual([settled.leads, settled.held.map(h => h.id)], [[], [id]], 'finished: the held candidate is listed read-only')
  armed = true
  const raced = await (await leadsGET(new NextRequest(`http://localhost/api/leads?job_id=${job}`))).json() as { leads: unknown[]; held: unknown[] }
  assert.equal(armed, false, 'the interleaving happened')
  assert.equal((db.prepare('SELECT enrich_finished_at FROM scan_jobs WHERE id = ?').get(job) as { enrich_finished_at: number | null }).enrich_finished_at, null, 'a new attempt started')
  assert.deepEqual([raced.leads, raced.held], [[], []], 'a stage that restarted mid-request lists nothing as held')
})
