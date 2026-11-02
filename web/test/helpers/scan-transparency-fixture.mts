// Shared fixture for the scan-status transparency slice: seeds an in-memory SQLite store, points
// BOTH the raw scan handle and the async Db layer at it, and calls the REAL status route handler.
// Used by test/scan-status-transparency.test.ts (route assertions) and, run directly, prints the
// exact serialized responses as JSON for test/ui/scan-transparency.ui.mjs - so the UI test renders
// bytes the route actually produced, not a hand-written stub that can drift from the API.
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { setDb, asDb } from '../../lib/db/client.ts'
import { migrateScan } from '../../lib/scan/store.ts'
import { migrateConnectors, audit } from '../../lib/connectors/store.ts'
import { migrateModelUsage } from '../../lib/scan/model-usage.ts'
import { GET } from '../../app/api/scan/status/route.ts'
import { GET as leadsGET } from '../../app/api/leads/route.ts'
import { migrateSourceReview } from '../../lib/scan/source-review.ts'
import { migrateWatch } from '../../lib/watch.ts'
import { migrateKeys } from '../../lib/llm/key-store.ts'
import { migratePlans } from '../../lib/plans.ts'
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

globalThis.fetch = (async () => { throw new Error('Unexpected network call') }) as typeof fetch

const d = new Database(':memory:')
migrateScan(d); migrateConnectors(d); migrateModelUsage(d)
for (const m of [migrateSourceReview, migrateWatch, migrateKeys, migratePlans, migrateAdvanced, migrateBilling, migrateOutreach, migrateAutopilot, migrateLedger, migrateReplies, migrateThreadReplies, migrateSequences, migrateTrial, migrateCompetitors, migrateEvents, migrateWarm, migrateSeo, migrateMonitors, migrateCsv, migrateCommenterImport, migrateMemory, migrateReopen]) m(d)
setScanDb(d)
setDb(asDb(d))

export const JOB_A = 'a'.repeat(24)
export const JOB_B = 'b'.repeat(24)
const estimate = JSON.stringify({
  total: { min: 0.10, max: 0.50 }, rows: [{ id: 'm1', label: 'Model', provider: 'anthropic', kind: 'model', unit: '1M tokens', unit_usd: '$3 in / $15 out', units: { min: 1, max: 2 }, usd: { min: 0.10, max: 0.50 } }],
  payer: 'you', cap: { max_usd: null, reserved_usd: 0, remaining_usd: null, binding: null, capped_total: { min: 0.10, max: 0.50 }, month_cap_usd: null, month_reserved_usd: 0, unknown: false },
})
// Tenant A: done scan, 4 verified, model usage 100k in / 10k out on claude-sonnet-4-5 (= $0.45), one rejected Apollo key + one rate-limited PDL lookup.
d.prepare("INSERT INTO scan_jobs (id, user_id, status, business_name, industry, location, verified, estimate, candidates) VALUES (?, 'A', 'running', 'Acme', 'i', 'l', 4, ?, 6)").run(JOB_A, estimate)
d.prepare("INSERT INTO scan_model_calls (tenant_id, job_id, attempt, seq, stage, method, model_requested, model_served, input_tokens, output_tokens, outcome, prompt_chars) VALUES ('A', ?, 1, 1, 'scoring', 'completeDetailed', 'claude-sonnet-4-5', 'claude-sonnet-4-5', 100000, 10000, 'ok', 500)").run(JOB_A)
audit(d, { tenantId: 'A', connector: 'enrich:apollo', jobId: JOB_A, lookup: 'org Acme', status: 'auth', results: 0 })
audit(d, { tenantId: 'A', connector: 'enrich:apollo', jobId: JOB_A, lookup: 'org Beta', status: 'rate_limited', results: 0 })
audit(d, { tenantId: 'A', connector: 'enrich:apollo', jobId: JOB_A, lookup: 'org Gamma', status: 'ok', results: 1 })
audit(d, { tenantId: 'A', connector: 'enrich:pdl', jobId: JOB_A, lookup: 'people Acme', status: 'rate_limited', results: 0 })
// Tenant B: done scan with its own failure, must stay invisible to A.
d.prepare("INSERT INTO scan_jobs (id, user_id, status, business_name, industry, location, verified, estimate, candidates) VALUES (?, 'B', 'done', 'Beta', 'i', 'l', 0, ?, 3)").run(JOB_B, estimate)
d.prepare("INSERT INTO scan_model_calls (tenant_id, job_id, attempt, seq, stage, method, model_requested, model_served, input_tokens, output_tokens, outcome, prompt_chars) VALUES ('B', ?, 1, 1, 'scoring', 'completeDetailed', 'claude-sonnet-4-5', 'claude-sonnet-4-5', 50000, 5000, 'ok', 400)").run(JOB_B)
audit(d, { tenantId: 'B', connector: 'enrich:apollo', jobId: JOB_B, lookup: 'org Secret', status: 'auth', results: 0 })

// The 4 leads that passed verification in tenant A's scan (verified=4): the leads list must show
// exactly these, so the page never pairs "across 4 leads" with an empty list. Timing stays
// held/unconfirmed (no event_date proof seeded) - no date or intent is asserted beyond the record.
const LEADS_A = [
  ['Northwind Dental', 'northwind-dental.test', 'Hiring an office manager', 'https://x.invalid/nw'],
  ['Bluepine Legal', 'bluepine-legal.test', 'Opening a second office', 'https://x.invalid/bp'],
  ['Kestrel Physio', 'kestrel-physio.test', 'Expanding to two locations', 'https://x.invalid/kp'],
  ['Harbor Optics', 'harbor-optics.test', 'New branch announced', 'https://x.invalid/ho'],
]
const insLead = d.prepare("INSERT INTO leads(id,scan_job_id,company,company_domain,name,contact,signal,source_url,evidence_excerpt,confidence,score,fit,intent,action,why) VALUES(?,?,?,?,'Pat','pat@x.invalid',?,?,?,80,70,5,4,3,'Strong fit on the recorded signal.')")
LEADS_A.forEach(([company, domain, signal, url], i) => insLead.run(`lead${i}`.padEnd(24, '0'), JOB_A, company, domain, signal, url, `${company}: ${signal}.`))
// Real lifecycle: leads land while the job runs, then the job completes.
d.prepare("UPDATE scan_jobs SET status='done' WHERE id=?").run(JOB_A)

export async function statusJson(userId: string, businessName: string, jobId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  setUser({ id: userId, business_name: businessName })
  const r = await GET(new NextRequest(`http://localhost/api/scan/status?job_id=${jobId}&passive=1`))
  return { status: r.status, body: await r.json() }
}

// Direct run: print the fixtures the UI test serves.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)) {
  const a = await statusJson('A', 'Acme', JOB_A)
  const b = await statusJson('B', 'Beta', JOB_B)
  setUser({ id: 'A', business_name: 'Acme' })
  const lr = await leadsGET(new NextRequest(`http://localhost/api/leads?job_id=${JOB_A}`))
  const leads_a = { status: lr.status, body: await lr.json() }
  process.stdout.write(JSON.stringify({ a, b, leads_a }))
}
