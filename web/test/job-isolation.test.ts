// Two-tenant isolation for the background jobs the tick runs (test/job-isolation-manifest.ts maps each job here).
// Every test runs the real worker for one tenant while the other tenant's data is due and eligible, and proves the
// run never reads, changes, sends, spends or deletes across the boundary. Synthetic fixtures, in-memory SQLite, no network.
import { seedOffers } from './helpers/seed-offer.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { completeOAuth, startOAuth, GMAIL_READ_SCOPE } from '../lib/gmail/oauth.ts'
import { saveSettings, type Deps } from '../lib/outreach/service.ts'
import { ATTESTATIONS, CONSENT_VERSION, enable, offerHashFor, migrateAutopilot, drainFirstTouch, runAutopilot } from '../lib/outreach/autopilot.ts'
import { migrateLedger } from '../lib/outreach/ledger.ts'
import { migrateReplies, acceptReadConsent, syncReplies } from '../lib/outreach/replies.ts'
import { runFollowups, setFollowups } from '../lib/outreach/followups.ts'
import { migrateSequences, acceptAutoSequencePolicy, AUTO_SEQUENCE_POLICY, enrollColdSequence, runSequences } from '../lib/outreach/sequences.ts'
import { migratePlans } from '../lib/plans.ts'
import { migrateKeys } from '../lib/llm/key-store.ts'
import { migrateWatch, createWatch, listWatches, runDueWatches } from '../lib/watch.ts'
import { migrateMonitors, createMonitor, listMonitors, runDueMonitors, collectMonitorResults } from '../lib/monitors.ts'
import { sqliteDb, type Db } from '../lib/db/client.ts'

const master = randomBytes(32)
const genv = { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'cs', PUBLIC_BASE_URL: 'https://app.test' }
const NOW = 1_800_000_000
const DAY = 86400
const ON = { AUTOPILOT_ENABLED: '1', AUTOPILOT_WARMUP: '0', SEQUENCES_ENABLED: '1' }
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status })
const idToken = (email: string) => 'x.' + Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url') + '.y'
const hex = () => randomBytes(12).toString('hex')
const D = (() => { const m = new WeakMap<Database.Database, Db>(); return (db: Database.Database) => { let d = m.get(db); if (!d) m.set(db, d = sqliteDb(db)); return d } })()

// One Gmail stub for every tenant: token calls succeed, thread reads answer from the given map, nothing else exists.
const gmail = (threads: Record<string, unknown[]>, calls: string[] = []) =>
  (async (url: string) => {
    const u = String(url); calls.push(u)
    if (u.includes('oauth2') || u.includes('token')) return json({ access_token: 'at' })
    const m = u.match(/threads\/([^?]+)/); if (m) return json({ messages: threads[m[1]] ?? [] })
    if (u.includes('messages?q=')) return json({ messages: [] })
    return json({}, 404)
  }) as unknown as typeof fetch
const msg = (id: string, threadId: string, from: string, body: string, at: number) => ({ id, threadId, internalDate: String(at * 1000), payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: from }], body: { data: Buffer.from(body).toString('base64url') } } })
const sendSpy = () => { const sent: { raw: string; thread?: string }[] = []; return { sent, sendFn: (async (_t: string, raw: string, _f: unknown, thread?: string) => { sent.push({ raw, thread }); return { id: 'g-' + sent.length, threadId: thread } }) as never } }
const deps = (over: object = {}): Deps & { flags: Record<string, string> } => ({ flags: ON, env: genv, master, now: NOW, baseUrl: 'https://app.test', fetchImpl: gmail({}), ...over })

async function onboard(db: Database.Database, t: string, email: string, read = true) {
  const state = new URL(startOAuth(db, t, { env: genv, now: NOW, withRead: read })).searchParams.get('state')!
  await completeOAuth(db, t, 'c', state, { env: genv, master, now: NOW, fetchImpl: (async () => json({ refresh_token: 'rt', scope: `https://www.googleapis.com/auth/gmail.send${read ? ' ' + GMAIL_READ_SCOPE : ''}`, id_token: idToken(email) })) as unknown as typeof fetch })
  saveSettings(db, t, { sender_name: 'Pat', postal_address: '1 King St W, Toronto ON M5H 1A1' })
  enable(db, t, { version: CONSENT_VERSION, attestations: [...ATTESTATIONS], daily_cap: 5 })
  if (read) acceptReadConsent(db, t)
}
function addLead(db: Database.Database, t: string, contact: string | null, company = 'Northside') {
  const job = createJob(db, t, { business_name: company, industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  const id = hex()
  db.prepare('INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence, score) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, job, company, contact, 'Hiring roofers', 'https://n.example/a', 'Northside is hiring', 90, 80)
  db.prepare("UPDATE leads SET human_confirmed_at = 1800000000, human_confirmed_from = 'test_review' WHERE id = ?").run(id)
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(job)
  return id
}
// A sent first touch for tenant t, threaded, so reply sync and follow-ups have a thread to work.
function sentMessage(db: Database.Database, t: string, leadId: string, email: string, at = NOW - 4 * DAY) {
  const mid = hex(), thread = 't-' + mid
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, claimed_at, gmail_id, thread_id) VALUES (?, ?, ?, ?, 'Quick question', 'bodybodybodybodybodybody', 'sent', ?, ?, ?, ?)").run(mid, t, leadId, email, at, at, 'g-' + mid, thread)
  return { mid, thread }
}
const count = (db: Database.Database, sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n

test('followups job, two tenants: B run sends nothing and leaves A untouched; A run sends only A due follow-up', async () => {
  const db = new Database(':memory:'); migrateScan(db); migrateOutreach(db); migrateConnectors(db); migrateAutopilot(db); migrateLedger(db); migrateReplies(db)
  await onboard(db, 'A', 'me@a.example'); await onboard(db, 'B', 'me@b.example')
  setFollowups(db, 'A', true); setFollowups(db, 'B', true)
  const leadA = addLead(db, 'A', 'sam@buyer.example')
  const sA = sentMessage(db, 'A', leadA, 'sam@buyer.example')
  await syncReplies(db, 'A', deps({ fetchImpl: gmail({ [sA.thread]: [msg('r' + sA.mid, sA.thread, 'sam@buyer.example', 'Interested, tell me more', NOW - 4 * DAY)] }) }))
  const bRowsBefore = count(db, "SELECT count(*) AS n FROM followup_threads WHERE tenant_id = 'B'")
  const spyB = sendSpy()
  const rb = await runFollowups(db, 'B', 'BCo', deps({ sendFn: spyB.sendFn }))
  assert.equal(rb.sent, 0); assert.equal(spyB.sent.length, 0)
  assert.equal(count(db, 'SELECT count(*) AS n FROM followup_messages'), 0, 'B\'s run claimed nothing, least of all A\'s thread')
  assert.equal(count(db, "SELECT count(*) AS n FROM followup_threads WHERE tenant_id = 'A' AND followups_sent = 0"), 1, 'A\'s thread unchanged by B\'s run')
  assert.equal(count(db, "SELECT count(*) AS n FROM followup_threads WHERE tenant_id = 'B'"), bRowsBefore)
  const spyA = sendSpy()
  const ra = await runFollowups(db, 'A', 'Acme', deps({ sendFn: spyA.sendFn }))
  assert.equal(ra.sent, 1)
  const mime = Buffer.from(spyA.sent[0].raw, 'base64url').toString()
  assert.match(mime, /^To: sam@buyer\.example$/m)
  assert.equal(count(db, "SELECT count(*) AS n FROM followup_messages WHERE tenant_id = 'B'"), 0, 'A\'s send created nothing for B')
})

test('first-touch jobs, two tenants: B drain and autopilot never draft, hold or send A leads; A run sends only to A', async () => {
  const db = new Database(':memory:'); migrateScan(db); migrateOutreach(db); migrateConnectors(db); migrateAutopilot(db); seedOffers(db)
  await onboard(db, 'A', 'me@a.example', false); await onboard(db, 'B', 'me@b.example', false)
  const warmed = (t: string) => { for (let i = 0; i < 2; i++) db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, claimed_at) VALUES (?, ?, ?, ?, 's', 'bodybodybodybodybodybody', 'sent', ?, ?)").run(hex(), t, 'x' + i, `o${i}@z.example`, NOW - 9e5, NOW - 9e5) }
  warmed('A'); warmed('B')
  addLead(db, 'A', 'sam@a.example')
  const leadHeld = addLead(db, 'A', 'd@four.example', 'Other Co')
  const heldId = hex()
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, hold_reason, hold_until, hold_policy, offer_hash) VALUES (?, 'A', ?, 'd@four.example', 's', 'bodybodybodybodybodybody', 'draft', 'daily_cap', ?, ?, ?)")
    .run(heldId, leadHeld, NOW - 60, CONSENT_VERSION, offerHashFor(db, 'A', leadHeld))
  const spyB = sendSpy()
  const warmFlags = { flags: { AUTOPILOT_ENABLED: '1', AUTOPILOT_WARMUP: '2' } }
  const dbRun = await drainFirstTouch(db, 'B', deps({ sendFn: spyB.sendFn, ...warmFlags }))
  assert.equal(dbRun.sent, 0)
  const apB = await runAutopilot(db, 'B', 'BCo', deps({ sendFn: spyB.sendFn, ...warmFlags }))
  assert.equal(apB.sent, 0); assert.equal(spyB.sent.length, 0)
  assert.equal((db.prepare('SELECT status FROM outreach_messages WHERE id = ?').get(heldId) as { status: string }).status, 'draft', 'A\'s due held draft untouched by B\'s drain')
  assert.equal(count(db, "SELECT count(*) AS n FROM outreach_messages WHERE tenant_id = 'B' AND to_email NOT LIKE '%@z.example'"), 0, 'B\'s autopilot drafted nothing from A\'s leads')
  const spyA = sendSpy()
  const apA = await runAutopilot(db, 'A', 'Acme', deps({ sendFn: spyA.sendFn, ...warmFlags }))
  assert.equal(apA.sent, 1)
  assert.match(Buffer.from(spyA.sent[0].raw, 'base64url').toString(), /^To: sam@a\.example$/m)
})

test('sequences job, two tenants: B run never advances A sequence; A run sends A step only', async () => {
  const db = new Database(':memory:'); migrateScan(db); migrateOutreach(db); migrateConnectors(db); migrateAutopilot(db); migrateLedger(db); migrateReplies(db); migrateSequences(db); seedOffers(db)
  await onboard(db, 'A', 'me@a.example'); await onboard(db, 'B', 'me@b.example')
  acceptAutoSequencePolicy(db, 'A', AUTO_SEQUENCE_POLICY)
  const leadA = addLead(db, 'A', 'sam@buyer.example', 'Acme')
  const sA = sentMessage(db, 'A', leadA, 'sam@buyer.example', NOW)
  const seqId = enrollColdSequence(db, 'A', sA.mid, { businessName: 'Acme' })!
  const spyB = sendSpy()
  const rb = await runSequences(db, 'B', 'BCo', deps({ sendFn: spyB.sendFn, now: NOW + 3 * DAY }))
  assert.equal(rb.sent, 0); assert.equal(spyB.sent.length, 0)
  const step2 = () => db.prepare('SELECT status, sent_at FROM sequence_steps WHERE sequence_id = ? AND step = 2').get(seqId) as { status: string; sent_at: number | null }
  assert.deepEqual(step2(), { status: 'approved', sent_at: null }, 'A\'s due step not advanced by B\'s run')
  const spyA = sendSpy()
  const ra = await runSequences(db, 'A', 'Acme', deps({ sendFn: spyA.sendFn, now: NOW + 3 * DAY }))
  assert.equal(ra.sent, 1)
  assert.match(Buffer.from(spyA.sent[0].raw, 'base64url').toString(), /^To: sam@buyer\.example$/m)
  assert.equal(step2().status, 'sent')
})

test('watch job, two tenants: a due run spends only the owner key and quota; one tenant exhausted never blocks the other', async () => {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON'); migrateScan(db); migratePlans(db); migrateKeys(db); migrateWatch(db)
  const ICP = JSON.stringify({ summary: 's', who: [], industries: [], sizes: [], where: [], signals: [], exclude: [] })
  const giveKey = (t: string) => db.prepare("INSERT INTO tenant_llm_keys (tenant_id, vendor, ciphertext, last4, validated_at) VALUES (?, 'anthropic', 'x', '1234', 1)").run(t)
  giveKey('A'); giveKey('B')
  const wA = (await createWatch(D(db), 'A', 'funded startups hiring', ICP)).watch!
  await createWatch(D(db), 'B', 'payroll tools hiring', ICP)
  db.prepare('UPDATE watches SET next_run_at = 1 WHERE id = ?').run(wA.id) // only A's watch is due
  const r1 = await runDueWatches(D(db))
  assert.deepEqual(r1, { ran: 1, paused: 0, skipped: 0 })
  const jobA = db.prepare('SELECT user_id, watch_id, funded_by FROM scan_jobs').get() as { user_id: string; watch_id: string; funded_by: string }
  assert.deepEqual(jobA, { user_id: 'A', watch_id: wA.id, funded_by: 'user' }, 'the only job belongs to A')
  assert.equal((await listWatches(D(db), 'B'))[0].last_run_at, null, 'B\'s watch never ran')
  // A exhausts the monthly quota; B's due watch still runs on B's own quota.
  for (let i = 0; i < 49; i++) db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES (?, 'A', 'b', 'i', 'l', 'done')").run(`old${i}`)
  db.prepare('UPDATE watches SET next_run_at = 1').run()
  const r2 = await runDueWatches(D(db))
  assert.deepEqual(r2, { ran: 1, paused: 1, skipped: 0 })
  assert.equal((await listWatches(D(db), 'A'))[0].paused_reason, 'quota_exceeded', 'A pauses on A\'s own quota')
  const bJobs = db.prepare("SELECT count(*) AS n FROM scan_jobs WHERE user_id = 'B'").get() as { n: number }
  assert.equal(bJobs.n, 1, 'B\'s watch ran on B\'s own quota')
})

test('monitor jobs, two tenants: due runs enqueue per-owner jobs; results fold only into the owner monitor', async () => {
  // migrateConnectors: monitor collection reads lead_enrichments (#387: gate and actionability markers).
  const db = new Database(':memory:'); migrateScan(db); migratePlans(db); migrateConnectors(db); migrateMonitors(db); migrateKeys(db)
  for (const t of ['A', 'B']) db.prepare("INSERT INTO tenant_llm_keys (tenant_id, vendor, ciphertext, last4, validated_at) VALUES (?, 'anthropic', 'x', '1234', 1)").run(t) // a monitor runs on the account's own key (#759)
  const mA = await createMonitor(D(db), 'A', { query: 'robotics companies hiring sales' })
  const mB = await createMonitor(D(db), 'B', { query: 'fintech seed rounds in Europe' })
  assert.ok('id' in mA && 'id' in mB)
  const jobs = await runDueMonitors(D(db))
  assert.equal(jobs.length, 2)
  const owners = db.prepare('SELECT user_id, count(*) AS n FROM scan_jobs GROUP BY user_id').all() as { user_id: string; n: number }[]
  assert.deepEqual(owners.sort((a, b) => a.user_id.localeCompare(b.user_id)), [{ user_id: 'A', n: 1 }, { user_id: 'B', n: 1 }])
  // Only A's job finishes with leads; collection must count them onto A's monitor run and leave B's run uncollected.
  const jobA = (db.prepare("SELECT job_id FROM monitor_runs WHERE monitor_id = ?").get((mA as { id: string }).id) as { job_id: string }).job_id
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(jobA)
  // Two companies with a verified, dated event each (#387: only novel, dated, in-window, verified events count as new).
  const today = new Date().toISOString().slice(0, 10)
  for (const k of ['acme', 'beta']) db.prepare("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, dedup_key, event_date, date_status, event_date_proof, confidence) VALUES (lower(hex(randomblob(12))), ?, 'n', ?, 's', 'https://e.com', ?, ?, 'unverified', 'page_bound', 80)").run(jobA, k, k, today)
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(jobA)
  assert.equal(await collectMonitorResults(D(db)), 1)
  assert.equal((db.prepare('SELECT new_count FROM monitor_runs WHERE monitor_id = ?').get((mA as { id: string }).id) as { new_count: number }).new_count, 2)
  assert.equal((db.prepare('SELECT new_count FROM monitor_runs WHERE monitor_id = ?').get((mB as { id: string }).id) as { new_count: number | null }).new_count, null, 'B\'s run never collected A\'s leads')
  assert.equal((await listMonitors(D(db), 'B')).length, 1)
})
