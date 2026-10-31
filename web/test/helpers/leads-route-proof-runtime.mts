// Route-seam GATE for #377 proof surfacing on GET /api/leads (real handler, stubbed session, no network).
// This is the post-integration counterpart to leads-route-timing-runtime.mts: once A's read layer
// (listLeads) selects event_date_proof / signal_kind, a row with a recognized, trigger-compatible
// proof surfaces its stored intent, labelled proof_backed; the stored grade is never rewritten.
// Until the read layer carries the columns this fails (the row stays held at 0/'unconfirmed') -
// that red is the no-half-wired gate, not a regression.
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
import { GET as leadsGET } from '../../app/api/leads/route.ts'

globalThis.fetch = (async () => { throw new Error('Unexpected network call') }) as typeof fetch

const daysAgoISO = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)

test('GET /api/leads: a persisted page_bound proof surfaces the stored intent, labelled proof_backed', async () => {
  const db = new Database(':memory:')
  for (const m of [migrateScan, migrateSourceReview, migrateWatch, migrateKeys, migratePlans, migrateConnectors, migrateAdvanced, migrateBilling, migrateOutreach, migrateAutopilot, migrateLedger, migrateReplies, migrateThreadReplies, migrateSequences, migrateTrial, migrateCompetitors, migrateEvents, migrateWarm, migrateSeo, migrateMonitors, migrateCsv, migrateCommenterImport, migrateMemory, migrateReopen]) m(db)
  setScanDb(db)
  setUser({ id: 'A', business_name: 'Acme' })
  const job = createJob(db, 'A', { business_name: 'Synthetic A', industry: 'test', location: 'test' })
  db.prepare("UPDATE scan_jobs SET status='running' WHERE id=?").run(job)
  const lead = randomBytes(12).toString('hex')
  db.prepare("INSERT INTO leads(id,scan_job_id,company,name,contact,signal,source_url,evidence_excerpt,confidence,score,fit,intent,action,why,signal_kind,event_date,event_date_proof,event_date_proof_note) VALUES(?,?,'Acme Dental','Pat','pat@acme.test','Opening a second clinic','https://x.invalid/a','Acme Dental opens a second clinic',80,70,5,4,3,'Strong fit: expanding practice.','expansion',?,'page_bound','stated in the clause of the evidence sentence that names this company')").run(lead, daysAgoISO(5))
  const res = await leadsGET(new NextRequest(`http://test/api/leads?job_id=${job}`))
  const body = await res.json() as { leads: { id: string; intent: number; stored_intent: number | null; timing: string; priority: { intent: number | null } | null }[] }
  const row = body.leads.find(l => l.id === lead)!
  assert.ok(row, 'the seeded lead is returned')
  assert.equal(row.timing, 'proof_backed', `a proof-bearing row must surface, got: ${JSON.stringify(row)}`)
  assert.equal(row.intent, 4)
  assert.equal(row.stored_intent, 4, 'the stored grade is preserved alongside, never rewritten')
  if (row.priority) assert.equal(row.priority.intent, 4, 'priority intent follows the same rule')
})
