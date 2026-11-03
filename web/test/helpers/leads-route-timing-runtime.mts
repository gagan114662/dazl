// Route-runtime proof for #377 surfacing on GET /api/leads (real handler, stubbed session, no network).
// This file covers the PRE-integration fallback: until the read layer returns event_date_proof,
// stored intent stays held at 0, labelled 'unconfirmed', with the stored grade preserved for
// inspection. The proof-surfacing case lands with the integration package (it needs A's columns).
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

test('GET /api/leads: without event-date proof a stored intent is held at 0 and labelled, never erased', async () => {
  const db = new Database(':memory:')
  for (const m of [migrateScan, migrateSourceReview, migrateWatch, migrateKeys, migratePlans, migrateConnectors, migrateAdvanced, migrateBilling, migrateOutreach, migrateAutopilot, migrateLedger, migrateReplies, migrateThreadReplies, migrateSequences, migrateTrial, migrateCompetitors, migrateEvents, migrateWarm, migrateSeo, migrateMonitors, migrateCsv, migrateCommenterImport, migrateMemory, migrateReopen]) m(db)
  setScanDb(db)
  setUser({ id: 'A', business_name: 'Acme' })
  const job = createJob(db, 'A', { business_name: 'Synthetic A', industry: 'test', location: 'test' })
  db.prepare("UPDATE scan_jobs SET status='running' WHERE id=?").run(job)
  const lead = randomBytes(12).toString('hex')
  db.prepare("INSERT INTO leads(id,scan_job_id,company,name,contact,signal,source_url,evidence_excerpt,confidence,score,fit,intent,action,why,signal_kind,event_date) VALUES(?,?,'Acme Dental','Pat','pat@acme.test','Opening a second clinic','https://x.invalid/a','Acme Dental opens a second clinic',80,70,5,4,3,'Strong fit: expanding practice.','expansion','2026-10-20')").run(lead, job)
  const res = await leadsGET(new NextRequest(`http://localhost/api/leads?job_id=${job}`))
  assert.equal(res.status, 200)
  const body = await res.json() as { leads: { id: string; intent: number; stored_intent: number | null; timing: string; priority: { intent: number | null } | null }[] }
  const row = body.leads.find(l => l.id === lead)!
  assert.ok(row, 'the seeded lead is returned')
  assert.equal(row.intent, 0, 'no proof on the row: intent is held at 0')
  assert.equal(row.timing, 'unconfirmed', 'and labelled, not silently zeroed')
  assert.equal(row.stored_intent, 4, 'the stored grade is preserved for inspection; no history rewritten')
  if (row.priority) assert.equal(row.priority.intent, 0, 'priority intent follows the same rule')
})
