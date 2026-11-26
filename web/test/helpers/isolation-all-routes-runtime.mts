// #830, workspace isolation, one sweep: every API route handler that takes the id of a tenant-owned thing (lead, scan
// job / play / campaign, monitor, watch, draft, sequence, reply thread, inbox thread, batch, booking, member,
// invitation, session) in its path, query string or JSON body.
//
// For each one, on the same fixture:
//   1. tenant B, signed in, calls it with tenant A's id: the answer must be a refusal (404 or 403; never a 2xx, never
//      an empty 200), must not contain any of A's marker values, and must leave A's rows byte-unchanged;
//   2. tenant A makes the same call on a fresh copy of the fixture and gets past the ownership check (the status each
//      case names), so a handler that refuses everyone, or a request shape that is refused for another reason (origin,
//      validation), cannot pass.
// Any outbound fetch is refused by the stub: nothing here is live data, a paid model call or a send.
// The list of cases is held against test/tenant-isolation-manifest.ts (ID_ROUTES): a route named there with no case
// here, or a case for a route not named there, fails the test.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { sqliteDb } from '../../lib/db/client.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { createJob } from '../../lib/scan/store.ts'
import { saveKey } from '../../lib/llm/key-store.ts'
import { saveCrmConfig } from '../../lib/crm/index.ts'
import { saveMemory } from '../../lib/memory.ts'
import { createMonitor } from '../../lib/monitors.ts'
import { createWatch } from '../../lib/watch.ts'
import { createReopenDraft } from '../../lib/outreach/reopen.ts'
import { createDraft, saveSettings } from '../../lib/outreach/service.ts'
import { createSequence } from '../../lib/outreach/sequences.ts'
import { addUserReportedPath } from '../../lib/warm/connections.ts'
import { createInvitation } from '../../lib/workspace-members.ts'
import { recordFeedback } from '../../lib/scan/feedback.ts'
import { acceptConsent } from '../../lib/advanced/index.ts'
import { createPairing, redeemPairing } from '../../lib/advanced/linkedin-connect.ts'
import { enqueueTask } from '../../lib/linkedin-tasks/store.ts'
import { createHash } from 'node:crypto'
import { ID_ROUTES } from '../tenant-isolation-manifest.ts'

process.env.DB_PATH ??= path.join(mkdtempSync(path.join(tmpdir(), 'dazl-iso-all-')), 'app.db')
process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
process.env.DAZL_QUALIFY_ENABLED = '1'

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response | undefined>
const load = async (p: string) => await import(`../../app/api/${p}/route.ts`) as Record<string, Handler>

const fetchCalls: string[] = []
globalThis.fetch = (async (u: unknown) => { fetchCalls.push(String(u)); throw new Error('Unexpected network call') }) as typeof fetch
const A = { id: 'A', business_name: 'Acme' }, B = { id: 'B', business_name: 'Beta' }
const hex = () => randomBytes(12).toString('hex')
let acting: 'A' | 'B' = 'B' // who is calling: the session (setUser) for session routes, the device token for the extension's route
const as = (who: 'A' | 'B') => { acting = who; setUser(who === 'A' ? A : B) }
const req = (url: string, method: string, body?: unknown) => new NextRequest(`http://localhost${url}`, {
  method, headers: { 'content-type': 'application/json', host: 'localhost', origin: 'http://localhost' }, body: body === undefined ? undefined : JSON.stringify(body) })
// Every value below appears only in tenant A's rows; none may ever reach tenant B.
const MARK = ['ASECRETCO5z1', 'ASECRETMUTUAL5z1', 'ASECRETCONTEXT5z1', 'ASECRETDRAFT5z1', 'ASECRETTHREAD5z1', 'ASECRETNEWS5z1', 'ASECRETWATCH5z1', 'ASECRETREOPEN5z1', 'ASECRETMONITOR5z1', 'ASECRETINBOX5z1', 'ASECRETSUBJECT5z1', 'asecret5z1']

// Tenant A's rows only: B may write rows of its own (an audit row for its refused attempt, its own rate-limit bucket).
function aRows(db: Database.Database): string {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('rate_limits', 'app_leases') ORDER BY name").all() as { name: string }[]).map(t => t.name)
  return JSON.stringify(tables.map(t => {
    const rows = db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all() as Record<string, unknown>[]
    return [t, rows.filter(r => r.tenant_id !== 'B' && r.user_id !== 'B')]
  }))
}
function changedTables(before: string, after: string): string[] {
  const a0 = JSON.parse(before) as [string, unknown[]][], a1 = JSON.parse(after) as [string, unknown[]][]
  return a1.filter(([n, r]) => JSON.stringify(r) !== JSON.stringify(a0.find(x => x[0] === n)?.[1])).map(([n]) => n)
}

async function build() {
  const db = new Database(':memory:')
  migrateAllSqlite(db)
  setScanDb(db)
  const adb = sqliteDb(db)
  const now = Math.floor(Date.now() / 1000)
  const master = Buffer.from(process.env.DAZL_MASTER_KEY!, 'base64')
  // Accounts and workspaces: A (owner A, operator M), B (owner B).
  for (const u of ['A', 'B', 'M']) db.prepare("INSERT INTO users (id, email, password_hash, salt, business_name) VALUES (?, ?, 'h', 's', ?)").run(u, `${u.toLowerCase()}@asecret5z1.invalid`, `Biz ${u}`)
  for (const u of ['A', 'B', 'M']) db.prepare("INSERT INTO organizations (id, name, kind, created_by, created_at) VALUES (?, ?, 'personal', ?, 0)").run(u, `Biz ${u}`, u)
  for (const [t, m, role] of [['A', 'A', 'owner'], ['B', 'B', 'owner'], ['A', 'M', 'operator'], ['M', 'M', 'owner']]) db.prepare('INSERT INTO memberships (tenant_id, member_id, role, created_at) VALUES (?, ?, ?, 0)').run(t, m, role)
  const session = hex()
  db.prepare("INSERT INTO sessions (id, user_id, expires_at, public_id) VALUES (?, 'A', ?, ?)").run(hex(), now + 86400, session)
  const invitation = (await createInvitation(adb, { tenantId: 'A', actorId: 'A', role: 'owner' }, 'invitee@asecret5z1.invalid', 'viewer')).id
  for (const t of ['A', 'B']) {
    saveKey(db, t, 'anthropic', `sk-ant-FIXTURE${t}-AAAAAAAAAAAAAAAAAAAAAA`, master)
    saveCrmConfig(db, t, { provider: 'hubspot', key: `fixture-crm-key-${t}` })
    saveMemory(db, t, { positioning: `${t} sells fixtures` })
    saveSettings(db, t, { sender_name: 'Pat', postal_address: '1 King St W, Toronto ON M5H 1A1' })
    db.prepare("INSERT INTO gmail_accounts (tenant_id, email, refresh_ct) VALUES (?, ?, 'x')").run(t, `${t.toLowerCase()}@example.test`)
  }
  const job = createJob(db, 'A', { business_name: 'Acme', industry: 'software', location: 'Toronto' })
  db.prepare("UPDATE scan_jobs SET status = 'running', query = 'ASECRETCO5z1 buyers' WHERE id = ?").run(job)
  const lead = (cols: Record<string, unknown> = {}) => {
    const id = hex()
    const row: Record<string, unknown> = { id, scan_job_id: job, company: 'ASECRETCO5z1', name: 'Pat', signal: 'Hiring', source_url: `https://asecret5z1.invalid/jobs/${id}`, score: 70, confidence: 80,
      evidence_excerpt: 'ASECRETCO5z1 is hiring', company_domain: 'asecret5z1.invalid', source_kind: 'query', ...cols }
    const k = Object.keys(row)
    db.prepare(`INSERT INTO leads (${k.join(', ')}) VALUES (${k.map(() => '?').join(', ')})`).run(...k.map(x => row[x]))
    return id
  }
  const review = lead({ review_reason: 'needs a human check' })
  const confirmed = lead({ human_confirmed_at: 1700000000 })
  const quarantined = lead({ quarantined_at: 1700000000 })
  const withContact = lead({ human_confirmed_at: 1, contact: 'hello@asecret5z1.invalid' }) // A's own draft-create control
  const seqLead = lead({ human_confirmed_at: 1, contact: 'seq@asecret5z1.invalid' })
  const seqLead2 = lead({ human_confirmed_at: 1, contact: 'seq2@asecret5z1.invalid' })
  const sentLead = lead({ human_confirmed_at: 1 }), sentLead4 = lead({ human_confirmed_at: 1 })
  const draftLead = lead({ human_confirmed_at: 1 }), draftLead3 = lead({ human_confirmed_at: 1 })
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(job)
  const pending = createJob(db, 'A', { business_name: 'Acme pending', industry: 'software', location: 'Toronto' })
  db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES (?, ?, 'A', 'apollo', 'contact', 'ASECRETMUTUAL5z1 - VP', 'c', 90, 'https://www.linkedin.com/in/asecret5z1', '2026-10-01', 1)").run(hex(), review)
  const warmPath = (await addUserReportedPath(adb, 'A', review, 'https://www.linkedin.com/in/asecret5z1', 'ASECRETMUTUAL5z1'))!.id
  const feedback = (await recordFeedback(adb, 'A', confirmed, { verdict: 'accept', actorId: 'A' })).id
  // The preserved text the `review` lead was verified against (leads/evidence reads it).
  const copy = hex(), sha = (v: string) => createHash('sha256').update(v).digest('hex')
  db.prepare('INSERT INTO lead_evidence_copies (id, tenant_id, job_id, attempt, source_url, canonical_url, title, title_sha256, sha256, text, byte_length, fetched_at, expires_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(copy, 'A', job, 'https://asecret5z1.invalid/jobs', 'https://asecret5z1.invalid/jobs', 'Jobs', sha('Jobs'), sha('ASECRETCO5z1 is hiring'), 'ASECRETCO5z1 is hiring', 22, now, now + 86400)
  db.prepare('UPDATE leads SET evidence_copy_id = ? WHERE id = ?').run(copy, review)
  const commenterBatch = hex()
  db.prepare("INSERT INTO commenter_batches (id, user_id, context, total) VALUES (?, 'A', 'ASECRETCONTEXT5z1', 0)").run(commenterBatch)
  const csvBatch = hex()
  db.prepare("INSERT INTO csv_batches (id, user_id, total, note) VALUES (?, 'A', 1, 'ASECRETCONTEXT5z1')").run(csvBatch)
  db.prepare("INSERT INTO csv_rows (id, batch_id, domain) VALUES (?, ?, 'asecret5z1.invalid')").run(hex(), csvBatch)
  const thread = hex() // a reply thread (social replies), with a draft
  db.prepare("INSERT INTO reply_threads (id, tenant_id, platform, url, title, quote, query) VALUES (?, 'A', 'reddit', 'https://reddit.invalid/r/x', 'ASECRETTHREAD5z1', 'q', 'q')").run(thread)
  db.prepare("INSERT INTO reply_drafts (thread_id, tenant_id, draft) VALUES (?, 'A', 'ASECRETDRAFT5z1')").run(thread)
  const news = hex()
  db.prepare("INSERT INTO newsjacks (id, tenant_id, url, title, draft) VALUES (?, 'A', 'https://news.invalid/a', 'ASECRETNEWS5z1', 'ASECRETNEWS5z1 draft')").run(news)
  const watch = (await createWatch(adb, 'A', 'ASECRETWATCH5z1 weekly play', '{"summary":"s"}')).watch!.id
  const created = await createMonitor(adb, 'A', { query: 'ASECRETMONITOR5z1 query' })
  assert.ok('id' in created, 'fixture: monitor created')
  const mon = (created as { id: string }).id
  db.prepare('INSERT INTO monitor_runs (id, monitor_id, job_id, ran_at, new_count) VALUES (?, ?, ?, ?, 1)').run(hex(), mon, job, now)
  // Drafts: one to edit / skip / polish, one to approve.
  const draft = hex(), draft3 = hex()
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status) VALUES (?, 'A', ?, 'pat@asecret5z1.invalid', 'ASECRETSUBJECT5z1', 'Fixture body text long enough for the guard, twenty chars plus.', 'draft')").run(draft, draftLead)
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status) VALUES (?, 'A', ?, 'pat3@asecret5z1.invalid', 'ASECRETSUBJECT5z1', 'Fixture body text long enough for the guard, twenty chars plus.', 'draft')").run(draft3, draftLead3)
  // Two conversations with a positive reply long ago, each with a reopen draft (one to skip, one to edit).
  for (const [t, l, g] of [['tA5z1', sentLead, 'g1'], ['tA5z1b', sentLead4, 'g2']]) {
    db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at) VALUES (?, 'A', ?, 'info@asecret5z1.invalid', 'ASECRETSUBJECT5z1', 'Hi Pat, first mail body here.', 'sent', ?)").run(hex(), l, now - 86400 * 50)
    db.prepare("INSERT INTO followup_threads (tenant_id, thread_id, lead_id, to_email, root_message_id, last_activity_at, last_lead_reply_at, followups_sent) VALUES ('A', ?, ?, 'info@asecret5z1.invalid', ?, ?, ?, 2)").run(t, l, `${g}@x`, now - 86400 * 45, now - 86400 * 45)
    db.prepare("INSERT INTO inbound_messages (gmail_id, tenant_id, thread_id, lead_id, from_email, excerpt, classification, received_at) VALUES (?, 'A', ?, ?, 'info@asecret5z1.invalid', 'ASECRETINBOX5z1 sounds interesting', 'positive', ?)").run(g, t, l, now - 86400 * 45)
    createReopenDraft(db, 'A', t, 'Acme')
  }
  db.prepare("INSERT INTO hiring_feed_crawl (lead_id, tenant_id, job_id, company_key, status, started_at) VALUES (?, 'A', ?, 'asecret5z1.invalid', 'failed', ?)").run(review, job, now - 3600)
  // One sequence in draft (to approve / edit / stop), and one more draft message to create a sequence from.
  const seqDraft = createDraft(db, 'A', seqLead, 'Acme')
  const sequence = createSequence(db, 'A', seqDraft, { businessName: 'Acme' })
  const seqDraft2 = createDraft(db, 'A', seqLead2, 'Acme')
  const booking = 'bk_asecret5z1'
  db.prepare("INSERT INTO calcom_bookings (tenant_id, booking_uid, attendee_email, attendee_name, lead_id) VALUES ('A', ?, 'pat@asecret5z1.invalid', 'Pat', NULL)").run(booking)
  // The dazl Connect extension: each workspace has a paired device (its bearer token) and accepted the LinkedIn notice;
  // A has one task out on lease.
  const device: Record<string, string> = {}
  for (const t of ['A', 'B']) {
    acceptConsent(db, t, 'linkedin')
    device[t] = (await redeemPairing(adb, (await createPairing(adb, t, t)).code))!.token
  }
  const task = (await enqueueTask(adb, 'A', 'company_people', 'https://www.linkedin.com/company/asecret5z1/people/', job))!
  db.prepare("UPDATE li_tasks SET status = 'leased', attempts = 1, served_at = ?, lease_until = ? WHERE id = ?").run(now, now + 600, task)
  return { device, task, db, job, pending, review, confirmed, quarantined, withContact, warmPath, commenterBatch, csvBatch, thread, news, watch, mon, draft, draft3, sequence, seqDraft2, booking, session, invitation, feedback }
}
type F = Awaited<ReturnType<typeof build>>

// route: 'METHOD /api/path' exactly as ID_ROUTES in test/tenant-isolation-manifest.ts names it. call: the request, made the same way for
// B (refused) and A (control). aOk: the statuses that show A got past the ownership check. aHas: text A's answer holds.
type Case = { route: string; note?: string; call: (f: F) => Promise<Response | undefined>; aOk: number[]; aHas?: string }
const m = {
  campaign: await load('campaigns/[id]'), confirm: await load('leads/[lead]/confirm'), domainReview: await load('leads/[lead]/domain-review'),
  enrichRetry: await load('leads/[lead]/enrich-retry'), feedback: await load('leads/[lead]/feedback'), findContact: await load('leads/[lead]/find-contact'),
  quarantine: await load('leads/[lead]/quarantine'), warm: await load('leads/[lead]/warm-path'), workEmail: await load('leads/[lead]/work-email'),
  evidence: await load('leads/evidence'), evidenceRecheck: await load('leads/evidence-recheck'), pageSignals: await load('leads/page-signals'),
  qualifyPreview: await load('leads/qualify-preview'), qualify: await load('leads/qualify'), leads: await load('leads'), exportLeads: await load('leads/export'),
  hiringFeed: await load('leads/hiring-feed'), playResearch: await load('leads/play-research'), monitor: await load('monitors/[id]'),
  outreachId: await load('outreach/[id]'), outreach: await load('outreach'), inbox: await load('outreach/inbox'), polish: await load('outreach/polish'),
  reopen: await load('outreach/reopen'), sequences: await load('outreach/sequences'), playNew: await load('plays/[kind]/[id]/new'),
  playRun: await load('plays/[kind]/[id]/run'), playRuns: await load('plays/[kind]/[id]/runs'), reply: await load('replies/[id]'), replies: await load('replies'),
  cancel: await load('scan/cancel'), commenters: await load('scan/commenters/[batch]'), csv: await load('scan/csv/[batch]'), status: await load('scan/status'),
  newsjack: await load('seo/newsjack'), watch: await load('watch'), crm: await load('crm'), calcom: await load('settings/calcom'),
  tasksComplete: await load('tasks/complete'),
  sessions: await load('auth/sessions'), invitations: await load('workspace/invitations'), members: await load('workspace/members'), preview: await load('preview/issue'),
}
const p = (params: Record<string, string>) => ({ params: Promise.resolve(params) })
const none = p({})
const leadRoute = (name: keyof typeof m, sub: string, method: string, which: (f: F) => string, body?: unknown): Case['call'] =>
  f => m[name][method](req(`/api/leads/${which(f)}/${sub}`, method, body), p({ lead: which(f) }))
const approval = { approved_by_user: true, vendor: 'anthropic', model: 'x', max_usd_estimate: 1, prompt_sha256: 'x', limits: {} }

const CASES: Case[] = [
  // --- id in the path
  { route: 'GET /api/campaigns/[id]', call: f => m.campaign.GET(req(`/api/campaigns/${f.job}`, 'GET'), p({ id: f.job })), aOk: [200], aHas: 'ASECRETCO5z1' },
  { route: 'POST /api/campaigns/[id]', call: f => m.campaign.POST(req(`/api/campaigns/${f.job}`, 'POST', { offer: 'CRM setup for clinics' }), p({ id: f.job })), aOk: [200] },
  { route: 'POST /api/leads/[lead]/confirm', call: leadRoute('confirm', 'confirm', 'POST', f => f.review, {}), aOk: [200] },
  { route: 'DELETE /api/leads/[lead]/confirm', call: leadRoute('confirm', 'confirm', 'DELETE', f => f.confirmed), aOk: [200] },
  { route: 'POST /api/leads/[lead]/domain-review', call: leadRoute('domainReview', 'domain-review', 'POST', f => f.review, { action: 'withdraw' }), aOk: [200], aHas: 'withdrawn' },
  { route: 'POST /api/leads/[lead]/enrich-retry', call: leadRoute('enrichRetry', 'enrich-retry', 'POST', f => f.review, { provider: 'apollo', step: 'org' }), aOk: [409] },
  { route: 'GET /api/leads/[lead]/feedback', call: leadRoute('feedback', 'feedback', 'GET', f => f.review), aOk: [200] },
  { route: 'POST /api/leads/[lead]/feedback', call: leadRoute('feedback', 'feedback', 'POST', f => f.review, { verdict: 'accept' }), aOk: [200] },
  { route: 'DELETE /api/leads/[lead]/feedback', call: f => m.feedback.DELETE(req(`/api/leads/${f.confirmed}/feedback`, 'DELETE', { id: f.feedback, reason: 'changed my mind' }), p({ lead: f.confirmed })), aOk: [200] },
  { route: 'POST /api/leads/[lead]/find-contact', call: leadRoute('findContact', 'find-contact', 'POST', f => f.confirmed, {}), aOk: [200, 503] },
  { route: 'POST /api/leads/[lead]/quarantine', call: leadRoute('quarantine', 'quarantine', 'POST', f => f.review, { reason: 'x' }), aOk: [200] },
  { route: 'DELETE /api/leads/[lead]/quarantine', call: leadRoute('quarantine', 'quarantine', 'DELETE', f => f.quarantined), aOk: [200] },
  { route: 'GET /api/leads/[lead]/warm-path', call: leadRoute('warm', 'warm-path', 'GET', f => f.review), aOk: [200], aHas: 'ASECRETMUTUAL5z1' },
  { route: 'POST /api/leads/[lead]/warm-path', call: leadRoute('warm', 'warm-path', 'POST', f => f.review, { contact_url: 'https://www.linkedin.com/in/someone-else', mutual_name: 'A mutual' }), aOk: [200] },
  { route: 'DELETE /api/leads/[lead]/warm-path', call: f => m.warm.DELETE(req(`/api/leads/${f.review}/warm-path`, 'DELETE', { id: f.warmPath }), p({ lead: f.review })), aOk: [200], aHas: '"deleted":true' },
  { route: 'GET /api/leads/[lead]/work-email', call: leadRoute('workEmail', 'work-email', 'GET', f => f.review), aOk: [200] },
  { route: 'POST /api/leads/[lead]/work-email', call: leadRoute('workEmail', 'work-email', 'POST', f => f.review, { target: 'ASECRETMUTUAL5z1|VP' }), aOk: [422] },
  { route: 'GET /api/monitors/[id]', call: f => m.monitor.GET(req(`/api/monitors/${f.mon}`, 'GET'), p({ id: f.mon })), aOk: [200] },
  { route: 'PATCH /api/monitors/[id]', call: f => m.monitor.PATCH(req(`/api/monitors/${f.mon}`, 'PATCH', { enabled: false }), p({ id: f.mon })), aOk: [200] },
  { route: 'DELETE /api/monitors/[id]', call: f => m.monitor.DELETE(req(`/api/monitors/${f.mon}`, 'DELETE'), p({ id: f.mon })), aOk: [200] },
  { route: 'PATCH /api/outreach/[id]', call: f => m.outreachId.PATCH(req(`/api/outreach/${f.draft}`, 'PATCH', { subject: 'An edit', body: 'An edited body text long enough to pass the guard here.' }), p({ id: f.draft })), aOk: [200] },
  { route: 'POST /api/outreach/[id]', note: 'skip', call: f => m.outreachId.POST(req(`/api/outreach/${f.draft}`, 'POST', { action: 'skip' }), p({ id: f.draft })), aOk: [200] },
  { route: 'POST /api/outreach/[id]', note: 'approve', call: f => m.outreachId.POST(req(`/api/outreach/${f.draft3}`, 'POST', { action: 'approve' }), p({ id: f.draft3 })), aOk: [200] },
  { route: 'GET /api/plays/[kind]/[id]/new', note: 'monitor', call: f => m.playNew.GET(req(`/api/plays/monitor/${f.mon}/new?since=0`, 'GET'), p({ kind: 'monitor', id: f.mon })), aOk: [200] },
  { route: 'GET /api/plays/[kind]/[id]/new', note: 'watch', call: f => m.playNew.GET(req(`/api/plays/watch/${f.watch}/new?since=0`, 'GET'), p({ kind: 'watch', id: f.watch })), aOk: [200] },
  { route: 'POST /api/plays/[kind]/[id]/run', note: 'monitor', call: f => m.playRun.POST(req(`/api/plays/monitor/${f.mon}/run`, 'POST', {}), p({ kind: 'monitor', id: f.mon })), aOk: [409], aHas: 'scan_active' }, // A's play, found; A already has a search queued
  { route: 'POST /api/plays/[kind]/[id]/run', note: 'watch', call: f => m.playRun.POST(req(`/api/plays/watch/${f.watch}/run`, 'POST', {}), p({ kind: 'watch', id: f.watch })), aOk: [409], aHas: 'scan_active' }, // A's play, found; A already has a search queued
  { route: 'GET /api/plays/[kind]/[id]/runs', note: 'monitor', call: f => m.playRuns.GET(req(`/api/plays/monitor/${f.mon}/runs`, 'GET'), p({ kind: 'monitor', id: f.mon })), aOk: [200] },
  { route: 'GET /api/plays/[kind]/[id]/runs', note: 'watch', call: f => m.playRuns.GET(req(`/api/plays/watch/${f.watch}/runs`, 'GET'), p({ kind: 'watch', id: f.watch })), aOk: [200] },
  { route: 'POST /api/replies/[id]', note: 'save', call: f => m.reply.POST(req(`/api/replies/${f.thread}`, 'POST', { action: 'save', draft: 'An edit of the reply draft.' }), p({ id: f.thread })), aOk: [200] },
  { route: 'POST /api/replies/[id]', note: 'mark', call: f => m.reply.POST(req(`/api/replies/${f.thread}`, 'POST', { action: 'mark', status: 'posted' }), p({ id: f.thread })), aOk: [200] },
  { route: 'GET /api/scan/commenters/[batch]', call: f => m.commenters.GET(req(`/api/scan/commenters/${f.commenterBatch}`, 'GET'), p({ batch: f.commenterBatch })), aOk: [200], aHas: 'ASECRETCONTEXT5z1' },
  { route: 'DELETE /api/scan/commenters/[batch]', call: f => m.commenters.DELETE(req(`/api/scan/commenters/${f.commenterBatch}`, 'DELETE'), p({ batch: f.commenterBatch })), aOk: [200] },
  { route: 'GET /api/scan/csv/[batch]', call: f => m.csv.GET(req(`/api/scan/csv/${f.csvBatch}`, 'GET'), p({ batch: f.csvBatch })), aOk: [200] },
  { route: 'POST /api/scan/csv/[batch]', call: f => m.csv.POST(req(`/api/scan/csv/${f.csvBatch}`, 'POST', {}), p({ batch: f.csvBatch })), aOk: [402], aHas: 'pro_only' }, // A's batch, found; the fixture workspace is on the free plan
  // --- id in the query string
  { route: 'GET /api/leads', call: f => m.leads.GET(req(`/api/leads?job_id=${f.job}`, 'GET'), none), aOk: [200], aHas: 'ASECRETCO5z1' },
  { route: 'GET /api/leads/export', call: f => m.exportLeads.GET(req(`/api/leads/export?job_id=${f.job}`, 'GET'), none), aOk: [200] },
  { route: 'GET /api/leads/evidence', call: f => m.evidence.GET(req(`/api/leads/evidence?lead_id=${f.review}`, 'GET'), none), aOk: [200], aHas: 'ASECRETCO5z1 is hiring' },
  { route: 'GET /api/leads/evidence-recheck', call: f => m.evidenceRecheck.GET(req(`/api/leads/evidence-recheck?lead_id=${f.review}`, 'GET'), none), aOk: [200], aHas: 'ASECRETCO5z1' },
  { route: 'GET /api/leads/page-signals', call: f => m.pageSignals.GET(req(`/api/leads/page-signals?lead_id=${f.review}`, 'GET'), none), aOk: [200] },
  { route: 'GET /api/leads/qualify-preview', call: f => m.qualifyPreview.GET(req(`/api/leads/qualify-preview?lead_id=${f.review}`, 'GET'), none), aOk: [200] },
  { route: 'GET /api/leads/hiring-feed', call: f => m.hiringFeed.GET(req(`/api/leads/hiring-feed?job_id=${f.job}`, 'GET'), none), aOk: [200], aHas: 'asecret5z1' },
  { route: 'GET /api/leads/play-research', call: f => m.playResearch.GET(req(`/api/leads/play-research?job_id=${f.job}`, 'GET'), none), aOk: [200] },
  { route: 'GET /api/scan/status', call: f => m.status.GET(req(`/api/scan/status?job_id=${f.job}&passive=1`, 'GET'), none), aOk: [200] },
  { route: 'GET /api/outreach/inbox', call: () => m.inbox.GET(req('/api/outreach/inbox?thread_id=tA5z1', 'GET'), none), aOk: [200], aHas: 'ASECRETINBOX5z1' },
  // --- id in the JSON body
  { route: 'POST /api/crm', call: f => m.crm.POST(req('/api/crm', 'POST', { action: 'push', lead_id: f.review }), none), aOk: [502] }, // found A's lead and tried the push: the fetch stub refused it
  { route: 'POST /api/leads/hiring-feed', call: f => m.hiringFeed.POST(req('/api/leads/hiring-feed', 'POST', { retry_job_id: f.job }), none), aOk: [202], aHas: '"retrying":1' },
  { route: 'POST /api/leads/play-research', call: f => m.playResearch.POST(req('/api/leads/play-research', 'POST', { job_id: f.job }), none), aOk: [400], aHas: 'Check company' }, // A's play, found; the research itself is then validated
  { route: 'POST /api/leads/qualify', call: f => m.qualify.POST(req('/api/leads/qualify', 'POST', { lead_id: f.review, approval }), none), aOk: [409], aHas: 'no_evidence' }, // A's lead, found; it has no stored fit-check input
  { route: 'POST /api/outreach', call: f => m.outreach.POST(req('/api/outreach', 'POST', { lead_id: f.withContact }), none), aOk: [201] },
  { route: 'POST /api/outreach/inbox', call: () => m.inbox.POST(req('/api/outreach/inbox', 'POST', { thread_id: 'tA5z1', action: 'read' }), none), aOk: [200] },
  { route: 'POST /api/outreach/polish', call: f => m.polish.POST(req('/api/outreach/polish', 'POST', { message_id: f.draft }), none), aOk: [200] },
  { route: 'POST /api/outreach/reopen', note: 'skip', call: () => m.reopen.POST(req('/api/outreach/reopen', 'POST', { action: 'skip', thread_id: 'tA5z1' }), none), aOk: [200] },
  { route: 'POST /api/outreach/reopen', note: 'edit', call: () => m.reopen.POST(req('/api/outreach/reopen', 'POST', { action: 'edit', thread_id: 'tA5z1b', body: 'An edited reopen body, long enough to pass.' }), none), aOk: [200] },
  { route: 'POST /api/outreach/sequences', note: 'create', call: f => m.sequences.POST(req('/api/outreach/sequences', 'POST', { action: 'create', message_id: f.seqDraft2 }), none), aOk: [200] },
  { route: 'POST /api/outreach/sequences', note: 'approve', call: f => m.sequences.POST(req('/api/outreach/sequences', 'POST', { action: 'approve', id: f.sequence }), none), aOk: [400], aHas: 'reading_not_enabled' }, // A's sequence, found; reply reading is off in the fixture
  { route: 'POST /api/outreach/sequences', note: 'edit', call: f => m.sequences.POST(req('/api/outreach/sequences', 'POST', { action: 'edit', id: f.sequence, step: 2, subject: 'An edit', body: 'An edited follow-up body, long enough to pass any guard.' }), none), aOk: [200] },
  { route: 'POST /api/outreach/sequences', note: 'stop', call: f => m.sequences.POST(req('/api/outreach/sequences', 'POST', { action: 'stop', id: f.sequence }), none), aOk: [200] },
  { route: 'POST /api/outreach/sequences', note: 'mark_sent', call: f => m.sequences.POST(req('/api/outreach/sequences', 'POST', { action: 'mark_sent', id: f.sequence, step: 1 }), none), aOk: [400], aHas: 'not_uncertain' }, // A's sequence, found; no send of it is uncertain
  { route: 'POST /api/replies', call: f => m.replies.POST(req('/api/replies', 'POST', { action: 'dismiss', id: f.thread }), none), aOk: [200] },
  { route: 'POST /api/scan/cancel', call: f => m.cancel.POST(req('/api/scan/cancel', 'POST', { job_id: f.pending }), none), aOk: [200] },
  { route: 'POST /api/seo/newsjack', call: f => m.newsjack.POST(req('/api/seo/newsjack', 'POST', { action: 'approve', id: f.news }), none), aOk: [200] },
  { route: 'POST /api/watch', call: f => m.watch.POST(req('/api/watch', 'POST', { action: 'pause', id: f.watch }), none), aOk: [200] },
  { route: 'POST /api/settings/calcom', call: f => m.calcom.POST(req('/api/settings/calcom', 'POST', { action: 'outcome', uid: f.booking, outcome: 'cancelled' }), none), aOk: [200] },
  { route: 'POST /api/preview/issue', call: f => m.preview.POST(req('/api/preview/issue', 'POST', { runId: f.job, business: 'Acme', recipientEmail: 'buyer@example.test' }), none), aOk: [409], aHas: '"hold"' }, // A's run, found; it has no proof ready to show
  // not a session route: the caller is the extension, authenticated by its workspace's device token
  { route: 'POST /api/tasks/complete', call: f => m.tasksComplete.POST(new NextRequest('http://localhost/api/tasks/complete', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${f.device[acting]}` }, body: JSON.stringify({ id: f.task, people: [] }) }), none), aOk: [200], aHas: 'stored' },
  { route: 'DELETE /api/auth/sessions', call: f => m.sessions.DELETE(req('/api/auth/sessions', 'DELETE', { id: f.session }), none), aOk: [200] },
  { route: 'DELETE /api/workspace/invitations', call: f => m.invitations.DELETE(req('/api/workspace/invitations', 'DELETE', { id: f.invitation }), none), aOk: [200] },
  { route: 'PATCH /api/workspace/members', call: () => m.members.PATCH(req('/api/workspace/members', 'PATCH', { member_id: 'M', role: 'viewer' }), none), aOk: [200] },
  { route: 'DELETE /api/workspace/members', call: () => m.members.DELETE(req('/api/workspace/members', 'DELETE', { member_id: 'M' }), none), aOk: [200] },
]
const label = (c: Case) => c.note ? `${c.route} (${c.note})` : c.route

test("every id-taking route: tenant B with tenant A's id is refused (404/403), A's rows stay byte-unchanged, and A's own call works", async () => {
  // The case list and the manifest's list of id-taking routes are the same set.
  const covered = new Set(CASES.map(c => c.route)), listed = new Set(ID_ROUTES.filter(r => !r.undriven).map(r => r.route))
  assert.deepEqual([...listed].filter(r => !covered.has(r)), [], 'id-taking routes in the manifest with no case here')
  assert.deepEqual([...covered].filter(r => !listed.has(r)), [], 'cases for routes the manifest does not list as id-taking')

  const f = await build()
  const before = aRows(f.db)
  const failures: string[] = []
  const refusals: Record<number, number> = {}
  for (const c of CASES) {
    as('B')
    const res = await c.call(f)
    if (!res) { failures.push(`${label(c)}: no response`); continue }
    const text = await res.text()
    refusals[res.status] = (refusals[res.status] ?? 0) + 1
    if (res.status !== 404 && res.status !== 403) failures.push(`${label(c)}: B with A's id got ${res.status} ${text.slice(0, 140)}`)
    for (const k of MARK) if (text.includes(k)) failures.push(`${label(c)}: response leaks A's ${k}`)
    const after = aRows(f.db)
    if (after !== before) { failures.push(`${label(c)}: A's data changed in ${changedTables(before, after).join(', ')}`); break }
  }
  as('B')
  for (const c of CASES.filter(c => c.route === 'POST /api/outreach/sequences')) {
    const foreign = await c.call(f)
    const missing = await c.call({ ...f, seqDraft2: hex(), sequence: hex() })
    assert.ok(foreign, label(c))
    assert.ok(missing, label(c))
    assert.equal(foreign.status, 404, label(c))
    assert.equal(missing.status, 404, label(c))
    assert.equal(foreign.headers.get('content-type'), missing.headers.get('content-type'), label(c))
    assert.equal(await foreign.text(), await missing.text(), label(c))
  }
  assert.equal(aRows(f.db), before, 'sequence action denials leave the other workspace unchanged')
  assert.equal(fetchCalls.length, 0, `B caused network attempts: ${fetchCalls.join(', ')}`)

  // Positive controls: the same call as A, each on a fresh fixture, gets past the ownership check.
  for (const c of CASES) {
    const g = await build()
    as('A')
    const res = await c.call(g)
    if (!res) { failures.push(`${label(c)}: A got no response`); continue }
    const text = await res.text()
    if (!c.aOk.includes(res.status)) failures.push(`${label(c)}: A's own call got ${res.status} ${text.slice(0, 200)} (expected ${c.aOk.join('/')})`)
    if (c.aHas && !text.includes(c.aHas)) failures.push(`${label(c)}: A's own answer lacks ${c.aHas}: ${text.slice(0, 200)}`)
  }
  assert.deepEqual(failures, [])
  console.log('ID ROUTES', covered.size, 'CASES', CASES.length, 'B ANSWERS', JSON.stringify(refusals))
})
