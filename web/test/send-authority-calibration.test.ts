// Shared post-await send-authority recheck (Refs #739, #925, #405, #467). Converted from the audit's fenced reproducer: synthetic
// tenant and addresses, injected fetch and send functions, no provider and no real send. Each case changes authority DURING the
// token await; the send handoff must then refuse. The control case (nothing changes) must still send, so a pass is not an inert test.
import { seedOffers } from './helpers/seed-offer.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateReplies } from '../lib/outreach/replies.ts'
import { completeOAuth, startOAuth, GMAIL_READ_SCOPE, GmailSendError } from '../lib/gmail/oauth.ts'
import { approve, createDraft, OutreachError, saveSettings, sendMessage, suppress, type Deps } from '../lib/outreach/service.ts'
import { ATTESTATIONS, auditAt, CONSENT_VERSION, disable, drainFirstTouch, enable, getState, migrateAutopilot, offerHashFor, pause, recentAutopilotAudit, runAutopilot, withdrawLaunch } from '../lib/outreach/autopilot.ts'
import { acceptLaunchPolicy, calibratedStop, launchGate, launchPolicyView, parsePolicy, readLaunchPolicy, reserveLaunchSpend, LAUNCH_POLICY_VERSION, ROLLOUT_DAILY_CAP, ROLLOUT_DAYS } from '../lib/outreach/launch-policy.ts'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { callCostUsd } from '../lib/llm/spend-guard.ts'
import type { Provider, DetailedCompletion } from '../lib/llm/provider.ts'
import { runCalibration } from '../lib/outreach/calibration.ts'
import { productTruth } from '../lib/product-truth.ts'

// #405 wiring: a calibrated launch replaces the hand-approval warmup only after an accepted policy passes the machine
// preflight. Synthetic tenant and leads (.example); every Gmail call is a stub that records what would have been sent.
const master = randomBytes(32)
const genv = { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'cs', PUBLIC_BASE_URL: 'https://app.test' }
const NOW = 1_800_000_000
const ON = { AUTOPILOT_ENABLED: '1' } // default warmup of 10
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status })
const idToken = (email: string) => 'x.' + Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url') + '.y'

async function connect(db: Database.Database, email: string, read = true) {
  const state = new URL(startOAuth(db, 'A', { env: genv, now: NOW })).searchParams.get('state')!
  const scope = ['https://www.googleapis.com/auth/gmail.send', ...(read ? [GMAIL_READ_SCOPE] : [])].join(' ')
  await completeOAuth(db, 'A', 'c', state, { env: genv, master, now: NOW, fetchImpl: (async () => json({ refresh_token: 'rt', scope, id_token: idToken(email) })) as unknown as typeof fetch })
}
async function setup(file = ':memory:') {
  const db = new Database(file, file === ':memory:' ? {} : { timeout: 50 }); migrateScan(db); migrateOutreach(db); migrateConnectors(db); migrateAutopilot(db); migrateReplies(db); seedOffers(db)
  // this suite seeds leads around completed runs (the launch lifecycle is under test, not the scan-job lifecycle
  // trigger, which the scan suites cover): a done play still takes fixture leads
  db.exec('DROP TRIGGER IF EXISTS leads_only_while_running')
  await connect(db, 'me@acme.example')
  saveSettings(db, 'A', { sender_name: 'Pat', postal_address: '1 King St W, Toronto ON M5H 1A1' })
  enable(db, 'A', { version: CONSENT_VERSION, attestations: [...ATTESTATIONS], daily_cap: 20 })
  return db
}
const play = (db: Database.Database) => {
  const job = createJob(db, 'A', { business_name: 'Acme', industry: 'x', location: 'y' })
  // finished: only leads of a done scan are autopilot's candidates
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(job)
  return job
}
function lead(db: Database.Database, job: string, contact: string | null, score = 80) {
  const id = randomBytes(12).toString('hex')
  db.prepare('INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence, score) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, job, 'Co ' + id.slice(0, 4), contact, 'Hiring roofers', 'https://n.example/a', 'Co is hiring', 90, score)
  db.prepare("UPDATE leads SET human_confirmed_at=1800000000, human_confirmed_from='test_review' WHERE id = ?").run(id)
  return id
}
const policy = (playIds: string[], over: Record<string, unknown> = {}) => ({
  version: LAUNCH_POLICY_VERSION, sender: 'me@acme.example', audience: { playIds }, exclusions: { domains: ['customer.example'], emails: [] },
  dailyCap: 20, spendCapUsd: 25, claims: { mayStatePrice: true, benchmarkUrls: [] }, stops: { pauseOnAnyReply: true, maxBounceRate: 0.05 },
  testInbox: 'me@acme.example', ...over,
})
// A recorded Gmail: sends are captured; the mailbox can be searched by Message-ID. delivered=false: Gmail accepts the
// send but the message never shows up in the INBOX (no receipt).
const gmail = (fail = false, delivered = true) => {
  const sent: string[] = []
  const ids = () => sent.map(r => /^Message-ID: <(.*)>$/m.exec(Buffer.from(r, 'base64url').toString())?.[1])
  const fetchImpl = (async (url: string) => {
    const u = String(url)
    if (u.includes('oauth2') || u.includes('token')) return json({ access_token: 'at' })
    const q = /[?&]q=([^&]*)/.exec(u)
    if (q) { const want = decodeURIComponent(q[1]).replace(/^rfc822msgid:/, ''); return json({ messages: delivered && ids().includes(want) ? [{ id: 'inbox1' }] : [] }) }
    if (u.endsWith('/inbox1?format=minimal')) return json({ id: 'inbox1', labelIds: ['INBOX', 'SENT'] })
    return json({}, 404)
  }) as unknown as typeof fetch
  const d: Deps & { flags: Record<string, string> } = { flags: ON, env: genv, master, now: NOW, baseUrl: 'https://app.test', fetchImpl,
    sendFn: (async (_t: string, raw: string) => { if (fail) throw new Error('gmail down'); sent.push(raw); return { id: 'g' + sent.length } }) as never }
  const to = () => sent.map(r => /^To: (.*)$/m.exec(Buffer.from(r, 'base64url').toString())?.[1])
  return { sent, d, to }
}
const statuses = (db: Database.Database) => db.prepare('SELECT status FROM outreach_messages ORDER BY created_at, rowid').all().map(r => (r as { status: string }).status)



for (const mode of ['control', 'disable', 'suppress', 'sender', 'unreadable'] as const) {
  test(`calibration launch check, authority ${mode === 'control' ? 'unchanged' : 'changed during the token await'}: ${mode === 'control' ? 'sends the check' : 'nothing is handed to Gmail'}`, async () => {
    const db = await setup(); const job = play(db)
    for (const c of ['a@one.example', 'b@two.example', 'c@three.example']) lead(db, job, c)
    acceptLaunchPolicy(db, 'A', policy([job]), NOW)
    const g = gmail(); const orig = g.d.fetchImpl as typeof fetch
    g.d.fetchImpl = (async (...args: Parameters<typeof fetch>) => {
      if (String(args[0]).includes('token')) {
        if (mode === 'disable') disable(db, 'A')
        if (mode === 'suppress') db.prepare("INSERT INTO suppressions (tenant_id, email, reason) VALUES ('A', 'me@acme.example', 'manual')").run()
        if (mode === 'sender') db.prepare("UPDATE gmail_accounts SET email = 'other@other.example' WHERE tenant_id = 'A'").run()
        if (mode === 'unreadable') db.exec('DROP TABLE suppressions')
      }
      return orig(...args)
    }) as typeof fetch
    const r = await runCalibration(db, 'A', 'Acme', g.d)
    if (mode === 'control') { assert.equal(g.sent.length, 1); assert.deepEqual(g.to(), ['me@acme.example']); assert.equal(r.ok, true) }
    else { assert.equal(g.sent.length, 0, 'no handoff'); assert.equal(r.ok, false); assert.ok(r.failures.includes('test_inbox_failed')); assert.equal(readLaunchPolicy(db, 'A')?.launchedAt ?? null, null, 'no launch recorded') }
    db.close()
  })
}
