// #1122 (1): the cost line's lead count is the leads the Leads page SHOWS, read through the real GET /api/leads handler
// (stubbed session, no network), never the scan's verified counter, which still counts leads the final checks hold.
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
import { costPerShownLead } from '../../lib/scan/cost-per-verification-pass.ts'
import { GET as leadsGET } from '../../app/api/leads/route.ts'

globalThis.fetch = (async () => { throw new Error('Unexpected network call') }) as typeof fetch

function store() {
  const db = new Database(':memory:')
  for (const m of [migrateScan, migrateSourceReview, migrateWatch, migrateKeys, migratePlans, migrateConnectors, migrateAdvanced, migrateBilling, migrateOutreach, migrateAutopilot, migrateLedger, migrateReplies, migrateThreadReplies, migrateSequences, migrateTrial, migrateCompetitors, migrateEvents, migrateWarm, migrateSeo, migrateMonitors, migrateCsv, migrateCommenterImport, migrateMemory, migrateReopen]) m(db)
  setScanDb(db); setUser({ id: 'A', business_name: 'Acme' })
  return db
}
const pageLeads = async (job: string) => {
  const res = await leadsGET(new NextRequest(`http://localhost/api/leads?job_id=${job}`))
  assert.equal(res.status, 200)
  return (await res.json() as { leads: { review_reason: string | null; seen_before?: number | null }[] }).leads
}

test('company-first: verified=1 but the final checks hold it - 0 leads shown, so no per-lead cost (never "across 1 lead")', async () => {
  const db = store()
  const job = createJob(db, 'A', { business_name: 'Synthetic A', industry: 'test', location: 'test' })
  db.prepare("UPDATE scan_jobs SET status='running', icp=? WHERE id=?").run(JSON.stringify({ window_days: 45 }), job)
  const day = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10)
  db.prepare("INSERT INTO leads(id,scan_job_id,company,name,signal,source_url,evidence_excerpt,confidence,score,review_reason,company_domain,event_date,event_date_proof,date_status) VALUES(?,?,'Board Co','','Hiring an SDR','https://job-boards.greenhouse.io/boardco/jobs/1','Board Co is hiring an SDR.',80,70,NULL,'boardco.test',?,'ats_structured','verified')").run(randomBytes(12).toString('hex'), job, day)
  db.prepare("UPDATE scan_jobs SET status='done',enrich_finished_at=1,candidates=1,verified=1,needs_review=0,dropped=0,run_budget=? WHERE id=?").run(markCompanyFirstBudget(null), job)
  const leads = await pageLeads(job)
  assert.equal(leads.length, 0)
  const c = costPerShownLead({ model_usd: 0.12, scanEnded: true, leads })
  assert.equal(c.shown, 0); assert.equal(c.usd_per_lead, null); assert.equal(c.unavailable, 'no leads shown'); assert.equal(c.model_usd, 0.12)
})

test('legacy scan: 3 ready leads (one a repeat behind the toggle) and 1 held - across 3 leads shown, not the verified counter', async () => {
  const db = store()
  const job = createJob(db, 'A', { business_name: 'Synthetic A', industry: 'test', location: 'test' })
  db.prepare("UPDATE scan_jobs SET status='running' WHERE id=?").run(job)
  const ins = db.prepare("INSERT INTO leads(id,scan_job_id,company,name,signal,source_url,evidence_excerpt,confidence,score,fit,review_reason,seen_before) VALUES(?,?,?,'Pat','Hiring an SDR',?,'Hiring an SDR.',80,70,4,?,?)")
  ins.run(randomBytes(12).toString('hex'), job, 'One Co', 'https://one.example/jobs', null, 0)
  ins.run(randomBytes(12).toString('hex'), job, 'Two Co', 'https://two.example/jobs', null, 0)
  ins.run(randomBytes(12).toString('hex'), job, 'Three Co', 'https://three.example/jobs', null, 1)
  ins.run(randomBytes(12).toString('hex'), job, 'Held Co', 'https://held.example/jobs', 'no_sales_hiring_evidence', 0)
  db.prepare("UPDATE scan_jobs SET status='done',enrich_finished_at=1,candidates=5,verified=5,needs_review=1,dropped=0 WHERE id=?").run(job)
  const leads = await pageLeads(job)
  const c = costPerShownLead({ model_usd: 0.3, scanEnded: true, leads })
  assert.equal(c.shown, 3)
  assert.ok(c.usd_per_lead !== null && Math.abs(c.usd_per_lead - 0.1) < 1e-12)
  assert.equal(c.unavailable, null)
})
