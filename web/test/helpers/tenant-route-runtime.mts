import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { sqliteDb } from '../../lib/db/client.ts'
import { migrateScan, createJob } from '../../lib/scan/store.ts'
import { migrateOutreach } from '../../lib/outreach/store.ts'
import { migrateReopen, createReopenDraft } from '../../lib/outreach/reopen.ts'
import { migrateReplies } from '../../lib/outreach/replies.ts'
import { migrateMonitors, createMonitor } from '../../lib/monitors.ts'
import { migrateSourceReview } from '../../lib/scan/source-review.ts'
import { migrateSequences } from '../../lib/outreach/sequences.ts'
import { migrateWatch } from '../../lib/watch.ts'
import { migrateKeys } from '../../lib/llm/key-store.ts'
import { migrateAdvanced } from '../../lib/advanced/index.ts'
import { migrateConnectors } from '../../lib/connectors/store.ts'
import { migratePlans } from '../../lib/plans.ts'
import { migrateBilling } from '../../lib/billing/stripe.ts'
import { migrateAutopilot } from '../../lib/outreach/autopilot.ts'
import { migrateLedger } from '../../lib/outreach/ledger.ts'
import { migrateCsv } from '../../lib/scan/csv-import.ts'
import { migrateCommenterImport } from '../../lib/scan/commenter-import.ts'
import { migrateMemory } from '../../lib/memory.ts'
import { migrateThreadReplies } from '../../lib/replies/threads.ts'
import { migrateTrial } from '../../lib/scan/trial.ts'
import { migrateCompetitors } from '../../lib/signals/competitor-reddit.ts'
import { migrateEvents } from '../../lib/events/store.ts'
import { migrateSeo } from '../../lib/seo/audit.ts'
import { migrateWarm } from '../../lib/warm/connections.ts'
import { PATCH as outreachPATCH, POST as outreachPOST } from '../../app/api/outreach/[id]/route.ts'
import { POST as reopenPOST } from '../../app/api/outreach/reopen/route.ts'
import { POST as confirmPOST, DELETE as confirmDELETE } from '../../app/api/leads/[lead]/confirm/route.ts'
import { PATCH as monitorPATCH, DELETE as monitorDELETE } from '../../app/api/monitors/[id]/route.ts'
import { POST as cancelPOST } from '../../app/api/scan/cancel/route.ts'

// Local synthetic fixture: two tenants, the real route handlers, session identity switched per call.
// Any outbound fetch fails the test. Nothing here is live data or a real send.
const fetchCalls: string[] = []
globalThis.fetch = (async (u: unknown) => { fetchCalls.push(String(u)); throw new Error('Unexpected network call') }) as typeof fetch
const A = { id: 'A', business_name: 'Acme' }, B = { id: 'B', business_name: 'Beta' }
const req = (path: string, method: string, body?: unknown) => new NextRequest(`http://localhost${path}`, {
  method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
const ctx = <T extends object>(p: T) => ({ params: Promise.resolve(p) })
const hex = () => randomBytes(12).toString('hex')

function snapshot(db: Database.Database): string {
  // rate_limits and app_leases are global platform tables (no tenant data); rateLimit() writes there through getDb().
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('rate_limits', 'app_leases') ORDER BY name").all() as { name: string }[]).map(t => t.name)
  return JSON.stringify(tables.map(t => [t, db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all()]))
}

async function build() {
  const db = new Database(':memory:')
  // Same migration set and order as the production getScanDb.
  for (const m of [migrateScan, migrateSourceReview, migrateWatch, migrateKeys, migratePlans, migrateConnectors, migrateAdvanced, migrateBilling, migrateOutreach, migrateAutopilot, migrateLedger, migrateReplies, migrateThreadReplies, migrateSequences, migrateTrial, migrateCompetitors, migrateEvents, migrateWarm, migrateSeo, migrateMonitors, migrateCsv, migrateCommenterImport, migrateMemory, migrateReopen]) m(db)
  setScanDb(db)
  const now = Math.floor(Date.now() / 1000)
  const job = createJob(db, 'A', { business_name: 'Synthetic A', industry: 'test', location: 'test' })
  db.prepare("UPDATE scan_jobs SET status='running' WHERE id=?").run(job)
  const lead = hex()
  db.prepare("INSERT INTO leads(id,scan_job_id,company,name,contact,signal,source_url,evidence_excerpt,confidence,human_confirmed_at,score) VALUES(?,?,?,'Pat',NULL,'Hiring','https://x.invalid/jobs',?,80,1,70)").run(lead, job, 'Synthetic A Co', 'Synthetic A Co is hiring')
  const draft = hex()
  db.prepare("INSERT INTO outreach_messages(id,tenant_id,lead_id,to_email,subject,body,status) VALUES(?,?,?,?,?,?,'draft')").run(draft, 'A', lead, 'info@a.invalid', 'FIXTURE subject', 'Fixture body text long enough for the guard, twenty chars plus.')
  const lead2 = hex()
  db.prepare("INSERT INTO leads(id,scan_job_id,company,name,contact,signal,source_url,evidence_excerpt,confidence,human_confirmed_at,score) VALUES(?,?,?,'Pat',NULL,'Hiring','https://x.invalid/jobs2',?,80,1,70)").run(lead2, job, 'Synthetic A2 Co', 'Synthetic A2 Co is hiring')
  const first = hex()
  db.prepare("INSERT INTO outreach_messages(id,tenant_id,lead_id,to_email,subject,body,status,sent_at) VALUES(?,?,?,?,?,?,'sent',?)").run(first, 'A', lead2, 'info@a.invalid', 'FIXTURE first', 'Hi Pat, first mail body here.', now - 86400 * 50)
  db.prepare("INSERT INTO followup_threads(tenant_id,thread_id,lead_id,to_email,root_message_id,last_activity_at,last_lead_reply_at,followups_sent) VALUES('A','tA',?,'info@a.invalid','r@x',?,?,2)").run(lead2, now - 86400 * 45, now - 86400 * 45)
  db.prepare("INSERT INTO inbound_messages(gmail_id,tenant_id,thread_id,lead_id,from_email,excerpt,classification,received_at) VALUES ('g','A','tA',?,'info@a.invalid','sounds interesting','positive',?)").run(lead2, now - 86400 * 45)
  createReopenDraft(db, 'A', 'tA', 'Acme')
  const created = await createMonitor(sqliteDb(db), 'A', { query: 'synthetic query' })
  assert.ok('id' in created, 'fixture: monitor created')
  // Independent valid fixtures for the approve and reopen-edit positive controls (their own leads, drafts and thread).
  const { saveSettings } = await import('../../lib/outreach/service.ts')
  saveSettings(db, 'A', { sender_name: 'Pat', postal_address: '1 King St W, Toronto ON M5H 1A1' })
  db.prepare("INSERT INTO gmail_accounts(tenant_id,email,refresh_ct) VALUES('A','a@example.test','x')").run()
  const lead3 = hex()
  db.prepare("INSERT INTO leads(id,scan_job_id,company,name,contact,signal,source_url,evidence_excerpt,confidence,human_confirmed_at,score) VALUES(?,?,?,'Pat',NULL,'Hiring','https://x.invalid/jobs3',?,80,1,70)").run(lead3, job, 'Synthetic A3 Co', 'Synthetic A3 Co is hiring')
  const draft3 = hex()
  db.prepare("INSERT INTO outreach_messages(id,tenant_id,lead_id,to_email,subject,body,status) VALUES(?,?,?,?,?,?,'draft')").run(draft3, 'A', lead3, 'info@a3.invalid', 'FIXTURE approve', 'Fixture body text long enough for the guard, twenty chars plus.')
  const lead4 = hex()
  db.prepare("INSERT INTO leads(id,scan_job_id,company,name,contact,signal,source_url,evidence_excerpt,confidence,human_confirmed_at,score) VALUES(?,?,?,'Pat',NULL,'Hiring','https://x.invalid/jobs4',?,80,1,70)").run(lead4, job, 'Synthetic A4 Co', 'Synthetic A4 Co is hiring')
  db.prepare("INSERT INTO outreach_messages(id,tenant_id,lead_id,to_email,subject,body,status,sent_at) VALUES(?,?,?,?,?,?,'sent',?)").run(hex(), 'A', lead4, 'info@a4.invalid', 'FIXTURE first', 'Hi Pat, first mail body here.', now - 86400 * 50)
  db.prepare("INSERT INTO followup_threads(tenant_id,thread_id,lead_id,to_email,root_message_id,last_activity_at,last_lead_reply_at,followups_sent) VALUES('A','tA4',?,'info@a4.invalid','r4@x',?,?,2)").run(lead4, now - 86400 * 45, now - 86400 * 45)
  db.prepare("INSERT INTO inbound_messages(gmail_id,tenant_id,thread_id,lead_id,from_email,excerpt,classification,received_at) VALUES ('g4','A','tA4',?,'info@a4.invalid','sounds interesting','positive',?)").run(lead4, now - 86400 * 45)
  createReopenDraft(db, 'A', 'tA4', 'Acme')
  const mon = (created as { id: string }).id
  const pending = createJob(db, 'A', { business_name: 'Synthetic pending', industry: 'test', location: 'test' })
  return { db, job, lead, draft, draft3, mon, pending }
}

test('tenant B cannot read or change tenant A rows through the real route handlers; A controls succeed', async () => {
  const { db, lead, draft, draft3, mon, pending } = await build()
  const reopenStatus = () => (db.prepare("SELECT status FROM reopen_messages WHERE tenant_id='A' AND thread_id='tA'").get() as { status: string }).status
  assert.equal(reopenStatus(), 'draft', 'fixture: A has a reopen draft')
  const before = snapshot(db)
  const cohort: string[] = []
  const hit = async (name: string, f: () => Promise<Response>, status: number, code?: string) => { cohort.push(name); setUser(B); const r = await f(); const j = await r.json().catch(() => ({})) as { error?: string }; assert.equal(r.status, status, `${name}: B got ${r.status} ${JSON.stringify(j)}`); if (code) assert.equal(j.error, code, `${name}: error code`); assert.equal(snapshot(db), before, `${name}: tenant A data byte-unchanged`) }

  await hit('PATCH /api/outreach/[id]', () => outreachPATCH(req(`/api/outreach/${draft}`, 'PATCH', { subject: 'HIJACK', body: 'HIJACK body text long enough to pass the guard here.' }), ctx({ id: draft })), 404, 'not_found')
  await hit('POST /api/outreach/[id] skip', () => outreachPOST(req(`/api/outreach/${draft}`, 'POST', { action: 'skip' }), ctx({ id: draft })), 404, 'not_found')
  await hit('POST /api/outreach/[id] approve', () => outreachPOST(req(`/api/outreach/${draft3}`, 'POST', { action: 'approve' }), ctx({ id: draft3 })), 404, 'not_found')
  await hit('POST /api/outreach/reopen skip', () => reopenPOST(req('/api/outreach/reopen', 'POST', { action: 'skip', thread_id: 'tA' })), 404, 'not_found')
  await hit('POST /api/outreach/reopen edit', () => reopenPOST(req('/api/outreach/reopen', 'POST', { action: 'edit', thread_id: 'tA4', body: 'HIJACK body long enough to pass.' })), 404, 'not_found')
  await hit('DELETE /api/leads/[lead]/confirm', () => confirmDELETE(req(`/api/leads/${lead}/confirm`, 'DELETE'), ctx({ lead })), 404, undefined)
  await hit('PATCH /api/monitors/[id]', () => monitorPATCH(req(`/api/monitors/${mon}`, 'PATCH', { enabled: false }), ctx({ id: mon })), 404, undefined)
  await hit('DELETE /api/monitors/[id]', () => monitorDELETE(req(`/api/monitors/${mon}`, 'DELETE'), ctx({ id: mon })), 404, undefined)
  await hit('POST /api/scan/cancel', () => cancelPOST(req('/api/scan/cancel', 'POST', { job_id: pending })), 404, undefined)
  assert.equal(snapshot(db), before)
  // Positive controls for the two negative-only actions run on their own valid fixtures before the final checks below.
  // Unauthenticated is refused too.
  setUser(null)
  assert.equal((await monitorDELETE(req(`/api/monitors/${mon}`, 'DELETE'), ctx({ id: mon }))).status, 401)
  assert.equal(snapshot(db), before)

  // Positive controls: the same calls as tenant A really change A's rows, so a handler that always rejects cannot pass.
  setUser(A)
  assert.equal((await outreachPATCH(req(`/api/outreach/${draft}`, 'PATCH', { subject: 'A edit', body: 'A edited body text long enough to pass the guard here.' }), ctx({ id: draft }))).status, 200)
  assert.equal((db.prepare('SELECT subject FROM outreach_messages WHERE id=?').get(draft) as { subject: string }).subject, 'A edit')
  assert.equal((await outreachPOST(req(`/api/outreach/${draft}`, 'POST', { action: 'skip' }), ctx({ id: draft }))).status, 200)
  assert.equal((db.prepare('SELECT status FROM outreach_messages WHERE id=?').get(draft) as { status: string }).status, 'skipped')
  const ap = await outreachPOST(req(`/api/outreach/${draft3}`, 'POST', { action: 'approve' }), ctx({ id: draft3 }))
  assert.equal(ap.status, 200, JSON.stringify(await ap.json().catch(() => ({}))))
  assert.equal((db.prepare('SELECT status FROM outreach_messages WHERE id=?').get(draft3) as { status: string }).status, 'approved')
  const ed = await reopenPOST(req('/api/outreach/reopen', 'POST', { action: 'edit', thread_id: 'tA4', body: 'A edited reopen body, long enough to pass.' }))
  assert.equal(ed.status, 200, JSON.stringify(await ed.json().catch(() => ({}))))
  assert.equal((db.prepare("SELECT body FROM reopen_messages WHERE tenant_id='A' AND thread_id='tA4'").get() as { body: string }).body, 'A edited reopen body, long enough to pass.')
  assert.equal((await reopenPOST(req('/api/outreach/reopen', 'POST', { action: 'skip', thread_id: 'tA' }))).status, 200)
  assert.equal(reopenStatus(), 'skipped')
  assert.equal((await confirmDELETE(req(`/api/leads/${lead}/confirm`, 'DELETE'), ctx({ lead }))).status, 200)
  assert.equal((await monitorPATCH(req(`/api/monitors/${mon}`, 'PATCH', { enabled: false }), ctx({ id: mon }))).status, 200)
  assert.equal((db.prepare('SELECT enabled FROM monitors WHERE id=?').get(mon) as { enabled: number }).enabled, 0)
  assert.equal((await monitorDELETE(req(`/api/monitors/${mon}`, 'DELETE'), ctx({ id: mon }))).status, 200)
  assert.equal(db.prepare('SELECT 1 FROM monitors WHERE id=?').get(mon), undefined)
  assert.equal((await cancelPOST(req('/api/scan/cancel', 'POST', { job_id: pending }))).status, 200)
  assert.equal((db.prepare('SELECT status FROM scan_jobs WHERE id=?').get(pending) as { status: string }).status, 'failed')
  assert.equal(fetchCalls.length, 0, 'no network call')
  console.log('COHORT', cohort.length, JSON.stringify(cohort))
})
