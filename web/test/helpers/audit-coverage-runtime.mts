// The audit trail (#371), the rest of docs/design/audit.md's "Covered" table, through the real route handlers and the
// real session lookup (audit-session-loader.mjs) over one SQLite fixture store, as audit-routes-runtime.mts does. Each
// step names exactly the events it must leave (actor, action, resource, resource id, redacted summary, the request's
// correlation id) or none at all, so a route that loses its audit() call, or records a change it did not make, fails
// here. Every outbound call (Google OAuth and Gmail, HubSpot, Stripe's billing portal) is answered by the stub below
// or fails the run. Synthetic data only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { withJar } from './pg-session-headers.ts'
import { setScanDb } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { createPasswordUser, createSession, hashToken } from '../../lib/auth-db.ts'
import { setErrorSinks } from '../../lib/ops/errors.ts'
import { seedOffers } from './seed-offer.ts'
import { startOAuth } from '../../lib/gmail/oauth.ts'
import { createDraft, saveSettings } from '../../lib/outreach/service.ts'
import { createSequence } from '../../lib/outreach/sequences.ts'
import { ATTESTATIONS, CONSENT_VERSION as AUTOPILOT_CONSENT, DEFAULT_DAILY, MAX_DAILY } from '../../lib/outreach/autopilot.ts'
import { READ_CONSENT_VERSION } from '../../lib/outreach/replies.ts'
import { CONSENT_VERSION as SOCIAL_CONSENT } from '../../lib/advanced/config.ts'

// Synthetic markers: none of these may ever appear in the audit table.
const MARK = {
  refresh: `1//synthetic-refresh-${'R'.repeat(30)}`, access: `ya29.synthetic-${'T'.repeat(30)}`, crmKey: `pat-na1-${'C'.repeat(30)}`,
  social: `synthetic-session-cookie-${'S'.repeat(30)}`, sender: 'Marker Sender Name', address: '1 Marker Street, Secretville',
  mailbox: 'owner-a@a-mail.example',
}
const idToken = (email: string) => 'x.' + Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url') + '.y'
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status })

// The stubbed outside world. gmail and hubspot answer what the current step needs.
const fetched: string[] = []
const stub = { gmail: 200, hubspot: [] as Response[] }
globalThis.fetch = (async (u: unknown) => {
  const url = String(u)
  fetched.push(url)
  if (url === 'https://oauth2.googleapis.com/token') return json({ access_token: MARK.access, refresh_token: MARK.refresh, scope: 'openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly', id_token: idToken(MARK.mailbox) })
  if (url === 'https://oauth2.googleapis.com/revoke') return json({})
  if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send') return stub.gmail === 200 ? json({ id: `gm${randomBytes(6).toString('hex')}`, threadId: 'th1' }) : json({ error: 'backend' }, stub.gmail)
  if (url === 'https://api.hubapi.com/crm/v3/objects/contacts' && stub.hubspot.length) return stub.hubspot.shift()!
  // pushLead reads a created contact back (#569): the stub holds what it created (lead 0's email)
  if (url === 'https://api.hubapi.com/crm/v3/objects/contacts/9001?properties=email,company') return json({ id: '9001', properties: { email: 'info@lead0.example', company: 'Lead Co 0' }, archived: false })
  if (url === 'https://api.stripe.com/v1/billing_portal/sessions') return json({ id: 'bps_synthetic', url: 'https://billing.stripe.test/p/session/bps_synthetic' })
  throw new Error(`Unexpected network call ${url}`)
}) as typeof fetch
process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
process.env.STRIPE_SECRET_KEY = 'sk_test_synthetic'
process.env.GOOGLE_CLIENT_ID = 'synthetic.apps.googleusercontent.com'
process.env.GOOGLE_CLIENT_SECRET = 'synthetic-client-secret'
process.env.PUBLIC_BASE_URL = 'https://app.test'
process.env.AUTOPILOT_ENABLED = '1'
process.env.ADVANCED_CONNECTORS = '1'
process.env.ADVANCED_WORKER_URL = 'https://worker.test'
process.env.ADVANCED_WORKER_TOKEN = 'synthetic-worker-token'

const raw = new Database(':memory:')
migrateAllSqlite(raw)
setScanDb(raw)
const route = async (p: string) => await import(`../../app/api/${p}/route.ts`)
const [message, autopilot, sequences, replies, advanced, gmailCallback, crm, portal, confirm, monitor, auditRoute, reopen,
  invitations, acceptRoute, members, leaveRoute, sessionsRoute, revokeAll, resetRoute, verifyRoute, commenterBatch] = await Promise.all(
  ['outreach/[id]', 'outreach/autopilot', 'outreach/sequences', 'outreach/replies', 'settings/advanced', 'gmail/callback', 'crm', 'billing/portal',
    'leads/[lead]/confirm', 'monitors/[id]', 'workspace/audit', 'outreach/reopen',
    'workspace/invitations', 'workspace/invitations/accept', 'workspace/members', 'workspace/leave', 'auth/sessions', 'auth/sessions/revoke-all',
    'auth/reset', 'auth/verify', 'scan/commenters/[batch]'].map(route))

const lastId: { v: string } = { v: '' }
const req = (path: string, method: string, body?: unknown) => {
  lastId.v = randomUUID()
  return new NextRequest(`http://localhost${path}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'content-type': 'application/json', host: 'localhost', origin: 'http://localhost', 'x-request-id': lastId.v },
  })
}
const as = <T,>(token: string, fn: () => Promise<T>) => withJar(new Map([['dazl_session', token]]), fn)
const user = (id: string) => ({ id, email: `${id.toLowerCase()}@example.test`, name: id, business_name: `Biz ${id}`, password_hash: 'h'.repeat(128), salt: 's'.repeat(32) })
type Ev = { action: string; actor_id: string; actor_kind: string; resource_type: string; resource_id: string | null; decision: string; summary: Record<string, unknown>; correlation_id: string | null }
const read = (token: string, q = ''): Promise<Response> => as(token, () => auditRoute.GET(req(`/api/workspace/audit${q}`, 'GET')) as Promise<Response>)
const ctx = <K extends string>(k: K, v: string) => ({ params: Promise.resolve({ [k]: v } as Record<K, string>) })
const hex = () => randomBytes(12).toString('hex')

// [actor, action, resource_type, resource_id, summary]
type Want = [string, string, string, string | null, Record<string, unknown>]
const top = () => (raw.prepare('SELECT coalesce(max(rowid), 0) AS n FROM audit_events').get() as { n: number }).n
const all: Want[] = []

test('every audited route in the Covered table records its event, with the redacted summary, and records nothing when nothing changed', async () => {
  for (const id of ['A', 'D', 'O']) await createPasswordUser(user(id))
  raw.prepare('UPDATE users SET email_verified_at = 1').run() // #357: only confirmed accounts have sessions
  // workspace A: owner A, admin D, operator O
  raw.prepare("INSERT INTO memberships (tenant_id, member_id, role, created_at) VALUES ('A', 'D', 'admin', 1), ('A', 'O', 'operator', 1)").run()
  const t: Record<string, string> = {}
  for (const id of ['A', 'D', 'O']) t[id] = await createSession(id)
  for (const id of ['D', 'O']) raw.prepare("UPDATE sessions SET active_tenant_id = 'A' WHERE id = ?").run(hashToken(t[id]))

  // One request; exactly the events `want` names, in order, all in workspace `tenant` (A unless named) under the
  // request's correlation id. Only workspace A's events are expected back from A's owner's read below.
  const step = async (name: string, token: string, fn: () => Promise<Response>, want: Want[], status = 200, tenant = 'A') => {
    const before = top()
    const r = await as(token, fn)
    assert.equal(r.status, status, `${name}: ${await r.clone().text()}`)
    const rows = (raw.prepare('SELECT * FROM audit_events WHERE rowid > ? ORDER BY rowid').all(before) as (Ev & { tenant_id: string; summary: string })[])
    assert.deepEqual(rows.map(e => [e.actor_id, e.action, e.resource_type, e.resource_id, JSON.parse(e.summary)]), want, name)
    for (const e of rows) {
      assert.equal(e.tenant_id, tenant, name); assert.equal(e.decision, 'allowed', name); assert.equal(e.actor_kind, 'user', name)
      assert.equal(e.correlation_id, lastId.v, `${name}: correlation id`)
    }
    if (tenant === 'A') all.push(...want)
    return r
  }
  const post = (path: string, body: unknown) => req(path, 'POST', body)

  // ---- reply reading and follow-ups: nothing given yet, so revoking or turning off changes nothing and records nothing
  await step('reply reading revoked, never given', t.A, () => replies.POST(post('/api/outreach/replies', { action: 'revoke' })), [])
  await step('follow-ups off, never on', t.A, () => replies.POST(post('/api/outreach/replies', { action: 'followups_off' })), [])

  // ---- Gmail connect: the OAuth callback with a stubbed token exchange
  const state = new URL(startOAuth(raw, 'A', { withRead: true })).searchParams.get('state')!
  const cb = await step('gmail connected', t.A, () => gmailCallback.GET(req(`/api/gmail/callback?code=synthetic-code&state=${encodeURIComponent(state)}`, 'GET')), [['A', 'credential.saved', 'gmail', null, {}]], 307)
  assert.equal(cb.headers.get('location'), 'https://app.test/app/settings?gmail=connected')
  assert.deepEqual(raw.prepare("SELECT email, status, read_granted FROM gmail_accounts WHERE tenant_id = 'A'").get(), { email: MARK.mailbox, status: 'active', read_granted: 1 })
  // a replayed callback (the state is one use) connects nothing and records nothing
  const restoreSinks = setErrorSinks([])
  try {
    const again = await step('gmail callback replayed', t.A, () => gmailCallback.GET(req(`/api/gmail/callback?code=synthetic-code&state=${encodeURIComponent(state)}`, 'GET')), [], 307)
    assert.equal(again.headers.get('location'), 'https://app.test/app/settings?gmail=error')
  } finally { restoreSinks() }

  await step('reply reading accepted', t.A, () => replies.POST(post('/api/outreach/replies', { action: 'consent', accept: true, version: READ_CONSENT_VERSION })),
    [['A', 'consent.accepted', 'reply_reading', null, { version: READ_CONSENT_VERSION }]])
  saveSettings(raw, 'A', { sender_name: MARK.sender, postal_address: MARK.address })
  seedOffers(raw, ['A'])

  // ---- leads: verified leads that a person confirms (pipeline.confirmed), one confirmation withdrawn (pipeline.unconfirmed)
  const job = hex()
  raw.prepare("INSERT INTO scan_jobs (id, user_id, status, business_name, industry, location) VALUES (?, 'A', 'running', 'Acme', 'roofing', 'Toronto')").run(job)
  const leads = Array.from({ length: 7 }, hex)
  leads.forEach((l, i) => raw.prepare("INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, evidence_excerpt, confidence, review_reason) VALUES (?, ?, 'Pat Lee', ?, ?, 'Hiring five roofers', 'https://news.example/a', ?, 85, 'quote_unconfirmed')")
    .run(l, job, `Lead Co ${i}`, `info@lead${i}.example`, `Lead Co ${i} is hiring five roofers`))
  raw.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(job)
  for (const l of leads) await step(`lead ${l} confirmed`, t.O, () => confirm.POST(post(`/api/leads/${l}/confirm`, {}), ctx('lead', l)), [['O', 'pipeline.confirmed', 'lead', l, {}]])
  await step('lead confirmed twice', t.O, () => confirm.POST(post(`/api/leads/${leads[6]}/confirm`, {}), ctx('lead', leads[6])), [], 404)
  await step('lead unconfirmed', t.O, () => confirm.DELETE(req(`/api/leads/${leads[6]}/confirm`, 'DELETE'), ctx('lead', leads[6])), [['O', 'pipeline.unconfirmed', 'lead', leads[6], {}]])
  await step('lead unconfirmed twice', t.O, () => confirm.DELETE(req(`/api/leads/${leads[6]}/confirm`, 'DELETE'), ctx('lead', leads[6])), [], 404)

  // ---- messages: approve, send (with its outcome), a repeat send of a sent message, skip, mark sent, retry
  const [m1, m2, m3, m4] = leads.slice(0, 4).map(l => createDraft(raw, 'A', l, 'Acme'))
  const act = (m: string, action: string) => () => message.POST(post(`/api/outreach/${m}`, { action }), ctx('id', m))
  const sends = () => fetched.filter(u => u.includes('gmail.googleapis.com')).length
  await step('message approved', t.O, act(m1, 'approve'), [['O', 'outreach.approve', 'message', m1, {}]])
  const sent = await step('message sent', t.O, act(m1, 'send'), [['O', 'outreach.send', 'message', m1, { outcome: 'sent' }]])
  assert.deepEqual(await sent.json(), { result: 'sent' })
  assert.equal(sends(), 1)
  // the second send of a sent message sends nothing and records nothing
  const resent = await step('message sent again', t.O, act(m1, 'send'), [])
  assert.deepEqual(await resent.json(), { result: 'sent' })
  assert.equal(sends(), 1, 'nothing more reached Gmail')
  await step('message skipped', t.O, act(m2, 'skip'), [['O', 'outreach.skip', 'message', m2, {}]])
  await step('skipped message skipped again', t.O, act(m2, 'skip'), [], 409)
  // Gmail answers 5xx: the message may have gone out, so the outcome is uncertain, and that is what the trail says
  await step('message 3 approved', t.O, act(m3, 'approve'), [['O', 'outreach.approve', 'message', m3, {}]])
  stub.gmail = 503
  const unsure = await step('message 3 send uncertain', t.O, act(m3, 'send'), [['O', 'outreach.send', 'message', m3, { outcome: 'uncertain' }]])
  assert.deepEqual(await unsure.json(), { result: 'uncertain' })
  await step('message 3 marked sent', t.O, act(m3, 'mark_sent'), [['O', 'outreach.mark_sent', 'message', m3, {}]])
  await step('message 3 marked sent twice', t.O, act(m3, 'mark_sent'), [], 409)
  await step('message 4 approved', t.O, act(m4, 'approve'), [['O', 'outreach.approve', 'message', m4, {}]])
  await step('message 4 send uncertain', t.O, act(m4, 'send'), [['O', 'outreach.send', 'message', m4, { outcome: 'uncertain' }]])
  await step('message 4 retried', t.O, act(m4, 'retry'), [['O', 'outreach.retry', 'message', m4, {}]])
  assert.equal((raw.prepare('SELECT status FROM outreach_messages WHERE id = ?').get(m4) as { status: string }).status, 'approved')
  stub.gmail = 200

  // ---- warm again (re-opens): send (sent, and uncertain when Gmail answers 5xx), retry, mark sent, skip. Drafting and
  // a refused repeat record nothing. Three quiet threads with leads 0-2, whose first emails went out above.
  const nowS = Math.floor(Date.now() / 1000)
  raw.prepare("INSERT INTO scheduler_progress (tenant_id, kind, last_attempt_at, last_success_at, last_outcome, consecutive_failures) VALUES ('A', 'reply_sync', ?, ?, 'success', 0)").run(nowS, nowS)
  const threads = [0, 1, 2].map(i => { const th = hex(); raw.prepare("INSERT INTO followup_threads (tenant_id, thread_id, lead_id, to_email, root_message_id, last_activity_at, last_lead_reply_at) VALUES ('A', ?, ?, ?, ?, ?, ?)").run(th, leads[i], `info@lead${i}.example`, `<root${i}@a-mail.example>`, nowS - 40 * 86400, nowS - 40 * 86400); return th })
  const ro = (body: Record<string, unknown>) => () => reopen.POST(post('/api/outreach/reopen', body))
  for (const th of threads) await step(`re-open drafted ${th}`, t.O, ro({ action: 'draft', thread_id: th }), [])
  const sentBefore = sends()
  await step('re-open sent', t.O, ro({ action: 'send', thread_id: threads[0] }), [['O', 'reopen.send', 'thread', threads[0], { outcome: 'sent' }]])
  assert.equal(sends(), sentBefore + 1)
  await step('re-open sent again: already sent, nothing recorded', t.O, ro({ action: 'send', thread_id: threads[0] }), [], 409)
  raw.prepare("UPDATE reopen_messages SET status = 'approved', sent_at = 1 WHERE tenant_id = 'A' AND thread_id = ?").run(threads[1])
  await step('re-open retried', t.O, ro({ action: 'retry', thread_id: threads[1] }), [['O', 'reopen.retry', 'thread', threads[1], {}]])
  await step('re-open retried again: not uncertain, nothing recorded', t.O, ro({ action: 'retry', thread_id: threads[1] }), [], 409)
  await step('re-open skipped', t.O, ro({ action: 'skip', thread_id: threads[1] }), [['O', 'reopen.skip', 'thread', threads[1], {}]])
  await step('re-open skipped again', t.O, ro({ action: 'skip', thread_id: threads[1] }), [], 409)
  stub.gmail = 503
  await step('re-open send uncertain', t.O, ro({ action: 'send', thread_id: threads[2] }), [['O', 'reopen.send', 'thread', threads[2], { outcome: 'uncertain' }]], 409)
  stub.gmail = 200
  await step('re-open sent while uncertain: refused, nothing recorded', t.O, ro({ action: 'send', thread_id: threads[2] }), [], 409)
  raw.prepare("UPDATE reopen_messages SET sent_at = 1 WHERE tenant_id = 'A' AND thread_id = ?").run(threads[2])
  await step('re-open marked sent', t.O, ro({ action: 'mark_sent', thread_id: threads[2] }), [['O', 'reopen.mark_sent', 'thread', threads[2], {}]])
  assert.deepEqual(threads.map(th => (raw.prepare("SELECT status FROM reopen_messages WHERE tenant_id = 'A' AND thread_id = ?").get(th) as { status: string }).status), ['sent', 'skipped', 'sent'])

  // ---- #371 review (2026-11-04T20:36:13Z): two real sessions race 'send' on the SAME draft. Operation identity is
  // the atomic claim, not state read before/after: the loser must leave no 'reopen.send' event attributed to it, even
  // though it sees the same 'draft' before and the winner's 'sent' after. Real route, real sessions, no sendFn stub.
  const raceThread = hex()
  raw.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at) VALUES (?, 'A', ?, 'info@lead5.example', 'Quick question for Lead Co 5', 'Hi, body text here for the first mail.', 'sent', ?)").run(hex(), leads[5], nowS - 86400 * 50)
  raw.prepare("INSERT INTO followup_threads (tenant_id, thread_id, lead_id, to_email, root_message_id, last_activity_at, last_lead_reply_at) VALUES ('A', ?, ?, ?, ?, ?, ?)").run(raceThread, leads[5], `info@lead5.example`, '<root-race@a-mail.example>', nowS - 40 * 86400, nowS - 40 * 86400)
  await step('re-open drafted (race)', t.O, ro({ action: 'draft', thread_id: raceThread }), [])
  const raceBefore = top()
  const sendsBeforeRace = sends()
  const [raceO, raceD] = await Promise.allSettled([as<Response>(t.O, ro({ action: 'send', thread_id: raceThread })), as<Response>(t.D, ro({ action: 'send', thread_id: raceThread }))])
  const statuses = [raceO, raceD].map(r => r.status === 'fulfilled' ? r.value.status : -1)
  assert.deepEqual(statuses.sort(), [200, 409], 'exactly one request wins the claim')
  assert.equal(sends(), sendsBeforeRace + 1, 'exactly one Gmail call, however the claim races')
  const raceEvents = raw.prepare('SELECT actor_id, action, summary FROM audit_events WHERE rowid > ? ORDER BY rowid').all(raceBefore) as { actor_id: string; action: string; summary: string }[]
  assert.equal(raceEvents.length, 1, `exactly one reopen.send event, win or lose: ${JSON.stringify(raceEvents)}`)
  assert.equal(raceEvents[0].action, 'reopen.send')
  assert.deepEqual(JSON.parse(raceEvents[0].summary), { outcome: 'sent' })
  const winner = statuses[0] === 200 ? 'O' : 'D'
  assert.equal(raceEvents[0].actor_id, winner, 'the event is attributed to the winner, never the loser')
  all.push([winner, 'reopen.send', 'thread', raceThread, { outcome: 'sent' }])

  // ---- autopilot: enable records the cap as applied (clamped to MAX_DAILY; the default when none is asked), not as asked
  const ap = (body: Record<string, unknown>) => () => autopilot.POST(post('/api/outreach/autopilot', body))
  const consent = { version: AUTOPILOT_CONSENT, attestations: [...ATTESTATIONS] }
  assert.equal(MAX_DAILY, 50)
  await step('autopilot enabled, cap 1000 asked', t.A, ap({ action: 'enable', ...consent, daily_cap: 1000 }), [['A', 'autopilot.enable', 'autopilot', null, { daily_cap: MAX_DAILY }]])
  await step('autopilot enable refused without consent', t.A, ap({ action: 'enable', version: 'old', attestations: [] }), [], 400)
  await step('autopilot paused', t.O, ap({ action: 'pause' }), [['O', 'autopilot.pause', 'autopilot', null, {}]])
  await step('autopilot paused again: already paused, nothing recorded', t.O, ap({ action: 'pause' }), [])
  await step('autopilot resumed', t.O, ap({ action: 'resume' }), [['O', 'autopilot.resume', 'autopilot', null, {}]])
  await step('autopilot resumed again: not paused, nothing recorded', t.O, ap({ action: 'resume' }), [])
  await step('autopilot disabled', t.A, ap({ action: 'disable' }), [['A', 'autopilot.disable', 'autopilot', null, {}]])
  await step('autopilot disabled again: already off, nothing recorded', t.A, ap({ action: 'disable' }), [])
  await step('autopilot enabled, no cap asked', t.A, ap({ action: 'enable', ...consent }), [['A', 'autopilot.enable', 'autopilot', null, { daily_cap: DEFAULT_DAILY }]])
  assert.equal(DEFAULT_DAILY, 20)
  await step('autopilot enabled, cap 7 asked', t.A, ap({ action: 'enable', ...consent, daily_cap: 7 }), [['A', 'autopilot.enable', 'autopilot', null, { daily_cap: 7 }]])

  // ---- follow-ups on and off; off again changes nothing
  await step('reply reading accepted again: already current, nothing recorded', t.A, () => replies.POST(post('/api/outreach/replies', { action: 'consent', accept: true, version: READ_CONSENT_VERSION })), [])
  await step('follow-ups on', t.A, () => replies.POST(post('/api/outreach/replies', { action: 'followups_on' })), [['A', 'followups.enabled', 'followups', null, {}]])
  await step('follow-ups on again: already on, nothing recorded', t.A, () => replies.POST(post('/api/outreach/replies', { action: 'followups_on' })), [])
  await step('follow-ups off', t.A, () => replies.POST(post('/api/outreach/replies', { action: 'followups_off' })), [['A', 'followups.disabled', 'followups', null, {}]])
  await step('follow-ups off again', t.A, () => replies.POST(post('/api/outreach/replies', { action: 'followups_off' })), [])
  // ---- reply reading revoked once given; then given again for the sequences below
  await step('reply reading revoked', t.A, () => replies.POST(post('/api/outreach/replies', { action: 'revoke' })), [['A', 'consent.revoked', 'reply_reading', null, {}]])
  await step('reply reading revoked again', t.A, () => replies.POST(post('/api/outreach/replies', { action: 'revoke' })), [])
  await step('reply reading accepted again', t.A, () => replies.POST(post('/api/outreach/replies', { action: 'consent', accept: true, version: READ_CONSENT_VERSION })),
    [['A', 'consent.accepted', 'reply_reading', null, { version: READ_CONSENT_VERSION }]])

  // ---- sequences: approve, mark sent and retry an uncertain step, resume, stop a running sequence (once)
  const seq = createSequence(raw, 'A', createDraft(raw, 'A', leads[4], 'Acme'), { businessName: 'Acme' })
  const sq = (body: Record<string, unknown>) => () => sequences.POST(post('/api/outreach/sequences', body))
  await step('sequence approved', t.O, sq({ action: 'approve', id: seq }), [['O', 'sequence.approve', 'sequence', seq, {}]])
  await step('sequence approved twice', t.O, sq({ action: 'approve', id: seq }), [], 400)
  // a step whose send outcome is unknown (the tick's claim was interrupted): the person says it went, or to retry it
  raw.prepare("UPDATE sequence_steps SET status = 'uncertain' WHERE sequence_id = ? AND step = 2").run(seq)
  await step('sequence step marked sent', t.O, sq({ action: 'mark_sent', id: seq, step: 2 }), [['O', 'sequence.mark_sent', 'sequence', seq, { step: 2 }]])
  await step('sequence step marked sent twice', t.O, sq({ action: 'mark_sent', id: seq, step: 2 }), [], 400)
  raw.prepare("UPDATE sequence_steps SET status = 'uncertain' WHERE sequence_id = ? AND step = 3").run(seq)
  await step('sequence step retried', t.O, sq({ action: 'retry', id: seq, step: 3 }), [['O', 'sequence.retry', 'sequence', seq, { step: 3 }]])
  raw.prepare("UPDATE autopilot_settings SET paused = 1, pause_reason = 'uncertain_send' WHERE tenant_id = 'A'").run()
  await step('sequences resumed', t.A, sq({ action: 'resume' }), [['A', 'sequence.resumed', 'sequences', null, {}]])
  await step('sequences resumed again: not paused, nothing recorded', t.A, sq({ action: 'resume' }), [])
  assert.equal((raw.prepare("SELECT paused FROM autopilot_settings WHERE tenant_id = 'A'").get() as { paused: number }).paused, 0)
  await step('sequence stopped', t.O, sq({ action: 'stop', id: seq }), [['O', 'sequence.stop', 'sequence', seq, {}]])
  await step('sequence stopped twice', t.O, sq({ action: 'stop', id: seq }), [])

  // ---- social channels (settings/advanced): consent, connector on/off only when a connector exists, session save/remove
  const adv = (body: Record<string, unknown>) => () => advanced.POST(post('/api/settings/advanced', body))
  await step('social consent accepted', t.D, adv({ platform: 'x', action: 'consent', accept: true, version: SOCIAL_CONSENT }), [['D', 'consent.accepted', 'social', 'x', { platform: 'x', version: SOCIAL_CONSENT }]])
  await step('social consent accepted again: already current, nothing recorded', t.D, adv({ platform: 'x', action: 'consent', accept: true, version: SOCIAL_CONSENT }), [])
  const none = await step('social toggle with no session', t.D, adv({ platform: 'x', action: 'toggle', enabled: true }), [])
  assert.deepEqual(await none.json(), { ok: false })
  await step('social session saved', t.D, adv({ platform: 'x', action: 'save', session: MARK.social }), [['D', 'credential.saved', 'social', 'x', { platform: 'x' }]])
  await step('social channel off', t.D, adv({ platform: 'x', action: 'toggle', enabled: false }), [['D', 'connector.disabled', 'social', 'x', { platform: 'x' }]])
  await step('social channel on', t.D, adv({ platform: 'x', action: 'toggle', enabled: true }), [['D', 'connector.enabled', 'social', 'x', { platform: 'x' }]])
  await step('social channel on again, already on', t.D, adv({ platform: 'x', action: 'toggle', enabled: true }), [])
  await step('social session removed', t.D, () => advanced.DELETE(req('/api/settings/advanced?platform=x', 'DELETE')), [['D', 'credential.removed', 'social', 'x', { platform: 'x' }]])
  const gone = await step('social session removed twice', t.D, () => advanced.DELETE(req('/api/settings/advanced?platform=x', 'DELETE')), [])
  assert.deepEqual(await gone.json(), { ok: false })
  await step('social consent revoked', t.D, adv({ platform: 'x', action: 'revoke' }), [['D', 'consent.revoked', 'social', 'x', { platform: 'x' }]])
  await step('social consent revoked again, none on record', t.D, adv({ platform: 'x', action: 'revoke' }), [])
  // two platforms share one notice: revoking the first removes the notice and turns its channel off (two events);
  // revoking the second only turns its channel off, and that change is recorded too
  await step('social consent accepted again', t.D, adv({ platform: 'x', action: 'consent', accept: true, version: SOCIAL_CONSENT }), [['D', 'consent.accepted', 'social', 'x', { platform: 'x', version: SOCIAL_CONSENT }]])
  await step('x session saved', t.D, adv({ platform: 'x', action: 'save', session: MARK.social }), [['D', 'credential.saved', 'social', 'x', { platform: 'x' }]])
  await step('reddit session saved', t.D, adv({ platform: 'reddit', action: 'save', session: MARK.social }), [['D', 'credential.saved', 'social', 'reddit', { platform: 'reddit' }]])
  await step('x revoked: notice and channel', t.D, adv({ platform: 'x', action: 'revoke' }), [['D', 'consent.revoked', 'social', 'x', { platform: 'x' }], ['D', 'connector.disabled', 'social', 'x', { platform: 'x' }]])
  await step('reddit revoked: notice already gone, channel turned off', t.D, adv({ platform: 'reddit', action: 'revoke' }), [['D', 'connector.disabled', 'social', 'reddit', { platform: 'reddit' }]])
  await step('reddit revoked again: nothing left to change', t.D, adv({ platform: 'reddit', action: 'revoke' }), [])
  // a consent at an older wording is still a row: revoking it is recorded
  raw.prepare("INSERT OR REPLACE INTO advanced_consent (tenant_id, scope, version, accepted_at) VALUES ('A', 'advanced', 'v0-old', 1)").run()
  await step('stale notice revoked', t.D, adv({ platform: 'x', action: 'revoke' }), [['D', 'consent.revoked', 'social', 'x', { platform: 'x' }]])
  raw.prepare("INSERT OR REPLACE INTO mail_read_consent (tenant_id, version, accepted_at) VALUES ('A', 'v0-old', 1)").run()
  await step('stale reply-reading consent revoked', t.A, () => replies.POST(post('/api/outreach/replies', { action: 'revoke' })), [['A', 'consent.revoked', 'reply_reading', null, {}]])

  // ---- CRM: a definite failure (HubSpot 4xx), a success (its record id), an unknown result resolved, disconnect once
  const cr = (body: Record<string, unknown>) => () => crm.POST(post('/api/crm', body))
  await step('crm disconnected, none connected', t.A, cr({ action: 'disconnect' }), [])
  await step('crm saved', t.A, cr({ action: 'save', provider: 'hubspot', key: MARK.crmKey }), [['A', 'credential.saved', 'crm', 'hubspot', { provider: 'hubspot' }]])
  const errSinks = setErrorSinks([])
  try {
    stub.hubspot.push(json({ message: 'Property values were not valid' }, 400))
    const refused = await step('crm push refused', t.O, cr({ action: 'push', lead_id: leads[0] }), [['O', 'crm.pushed', 'lead', leads[0], { provider: 'hubspot', outcome: 'failed' }]], 502)
    assert.equal(((await refused.json()) as { outcome: string }).outcome, 'failed')
    stub.hubspot.push(json({ id: '9001' }, 201))
    const ok = await step('crm push ok', t.O, cr({ action: 'push', lead_id: leads[0] }), [['O', 'crm.pushed', 'lead', leads[0], { provider: 'hubspot', outcome: 'ok' }]])
    assert.equal(((await ok.json()) as { external_id: string }).external_id, '9001')
    // pushed already: the recorded result, no second create and no second event
    await step('crm push repeated', t.O, cr({ action: 'push', lead_id: leads[0] }), [])
    stub.hubspot.push(json({ status: 'error' }, 502))
    await step('crm push unknown', t.O, cr({ action: 'push', lead_id: leads[1] }), [['O', 'crm.pushed', 'lead', leads[1], { provider: 'hubspot', outcome: 'unknown' }]], 502)
  } finally { errSinks() }
  assert.equal(stub.hubspot.length, 0)
  await step('crm unknown resolved', t.O, cr({ action: 'resolve', lead_id: leads[1], created: false }), [['O', 'crm.resolved', 'lead', leads[1], { provider: 'hubspot', created: false }]])
  await step('crm resolved twice', t.O, cr({ action: 'resolve', lead_id: leads[1], created: true }), [], 409)
  await step('crm disconnected', t.A, cr({ action: 'disconnect' }), [['A', 'credential.removed', 'crm', null, {}]])
  await step('crm disconnected twice', t.A, cr({ action: 'disconnect' }), [])

  // ---- billing portal: only once there is a Stripe customer to open it for
  await step('portal, no customer', t.A, () => portal.POST(post('/api/billing/portal', {})), [], 404)
  raw.prepare("INSERT INTO tenant_plans (tenant_id, plan, stripe_customer_id) VALUES ('A', 'pro', 'cus_synthetic') ON CONFLICT(tenant_id) DO UPDATE SET stripe_customer_id = excluded.stripe_customer_id").run()
  const po = await step('portal opened', t.A, () => portal.POST(post('/api/billing/portal', {})), [['A', 'billing.portal_opened', 'plan', null, {}]])
  assert.equal(((await po.json()) as { url: string }).url, 'https://billing.stripe.test/p/session/bps_synthetic')

  // ---- monitor paused, then resumed (monitor.enabled)
  const mon = hex()
  raw.prepare("INSERT INTO monitors (id, user_id, query, interval_hours, next_run_at, created_at) VALUES (?, 'A', 'synthetic monitor query', 24, 0, 1)").run(mon)
  const pm = (enabled: boolean) => () => monitor.PATCH(req(`/api/monitors/${mon}`, 'PATCH', { enabled }), ctx('id', mon))
  await step('monitor paused', t.O, pm(false), [['O', 'monitor.disabled', 'monitor', mon, {}]])
  await step('monitor paused again: already paused, nothing recorded', t.O, pm(false), [])
  await step('monitor resumed', t.O, pm(true), [['O', 'monitor.enabled', 'monitor', mon, {}]])
  await step('monitor resumed again: already running, nothing recorded', t.O, pm(true), [])

  // ---- team (Settings > Team): invitations created, revoked and accepted; a role changed; a member removed; a member
  // leaving. The trail holds invitation ids and roles, never the link's token or the invitee's address.
  const sha = (v: string) => createHash('sha256').update(v).digest('hex')
  const secrets: string[] = []
  const emailToken = (userId: string, purpose: string, email: string) => {
    const tok = randomBytes(32).toString('hex')
    raw.prepare('INSERT INTO email_tokens (id, user_id, purpose, email, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(hex(), userId, purpose, email, sha(tok), nowS, nowS + 3600)
    secrets.push(tok, sha(tok))
    return tok
  }
  await createPasswordUser(user('N'))
  t.N = await createSession('N')
  // N proves its own address: a verification, not a change of address, so nothing is recorded
  raw.prepare("UPDATE users SET email_verified_at = NULL WHERE id = 'N'").run()
  await step('own address verified: not a change, nothing recorded', '', () => verifyRoute.POST(post('/api/auth/verify', { token: emailToken('N', 'verify', 'n@example.test') })), [])
  // the invitation's id is only known from the response, so the step's expected event is checked once it is
  const created = async (name: string, token: string, by: string, email: string, role: string) => {
    const before = top()
    const r = await as(token, () => invitations.POST(post('/api/workspace/invitations', { email, role })) as Promise<Response>)
    assert.equal(r.status, 200, name)
    const inv = (await r.json()) as { id: string; link: string }
    const rows = raw.prepare('SELECT * FROM audit_events WHERE rowid > ? ORDER BY rowid').all(before) as (Ev & { tenant_id: string; summary: string })[]
    assert.deepEqual(rows.map(e => [e.tenant_id, e.actor_id, e.action, e.resource_type, e.resource_id, JSON.parse(e.summary), e.correlation_id]),
      [['A', by, 'invitation.created', 'invitation', inv.id, { role }, lastId.v]], name)
    all.push([by, 'invitation.created', 'invitation', inv.id, { role }])
    const tok = inv.link.split('#t=')[1]
    assert.match(tok, /^[a-f0-9]{64}$/)
    secrets.push(tok, sha(tok))
    return { id: inv.id, token: tok }
  }
  const inv1 = await created('invitation created', t.A, 'A', 'n@example.test', 'operator')
  await step('invitation refused: not an address, nothing recorded', t.A, () => invitations.POST(post('/api/workspace/invitations', { email: 'nope', role: 'viewer' })), [], 400)
  const inv2 = await created('invitation created by an admin', t.D, 'D', 'later@example.test', 'viewer')
  await step('invitation revoked', t.D, () => invitations.DELETE(req('/api/workspace/invitations', 'DELETE', { id: inv2.id })), [['D', 'invitation.revoked', 'invitation', inv2.id, { role: 'viewer' }]])
  await step('invitation revoked twice', t.D, () => invitations.DELETE(req('/api/workspace/invitations', 'DELETE', { id: inv2.id })), [], 404)
  await step('invitation refused to an operator, nothing recorded', t.O, () => invitations.POST(post('/api/workspace/invitations', { email: 'x@example.test', role: 'viewer' })), [], 403)
  // accepted in workspace A (the one joined), under the account that accepted it
  const acc = await step('invitation accepted', t.N, () => acceptRoute.POST(post('/api/workspace/invitations/accept', { token: inv1.token })), [['N', 'invitation.accepted', 'invitation', inv1.id, { role: 'operator', joined: true }]])
  assert.deepEqual(await acc.json(), { ok: true, tenant_id: 'A', role: 'operator', switched: true })
  await step('invitation accepted twice: used up, nothing recorded', t.N, () => acceptRoute.POST(post('/api/workspace/invitations/accept', { token: inv1.token })), [], 410)
  const role = (body: Record<string, unknown>) => () => members.PATCH(req('/api/workspace/members', 'PATCH', body))
  await step('role changed', t.A, role({ member_id: 'N', role: 'viewer' }), [['A', 'member.role_changed', 'member', 'N', { from: 'operator', to: 'viewer' }]])
  await step('role set to the one held: nothing changed, nothing recorded', t.A, role({ member_id: 'N', role: 'viewer' }), [])
  await step('role change refused to an operator', t.O, role({ member_id: 'N', role: 'admin' }), [], 403)
  assert.equal((raw.prepare("SELECT role FROM memberships WHERE tenant_id = 'A' AND member_id = 'N'").get() as { role: string }).role, 'viewer')
  await step('member left', t.N, () => leaveRoute.POST(post('/api/workspace/leave', {})), [['N', 'member.left', 'member', 'N', { role: 'viewer' }]])
  assert.equal(raw.prepare("SELECT 1 FROM memberships WHERE tenant_id = 'A' AND member_id = 'N'").get(), undefined)

  // ---- deletion: a commenter import batch and what it made (data.deleted), once
  const batch = hex()
  raw.prepare("INSERT INTO commenter_batches (id, user_id, context, total) VALUES (?, 'A', 'synthetic commenter context', 0)").run(batch)
  const delBatch = () => commenterBatch.DELETE(req(`/api/scan/commenters/${batch}`, 'DELETE'), ctx('batch', batch))
  await step('commenter batch deleted', t.O, delBatch, [['O', 'data.deleted', 'commenter_batch', batch, {}]])
  await step('commenter batch deleted twice', t.O, delBatch, [], 404)

  await step('member removed', t.A, () => members.DELETE(req('/api/workspace/members', 'DELETE', { member_id: 'O' })), [['A', 'member.removed', 'member', 'O', { role: 'operator' }]])
  await step('member removed twice', t.A, () => members.DELETE(req('/api/workspace/members', 'DELETE', { member_id: 'O' })), [], 404)

  // ---- devices (Settings > Devices): account security, recorded in the account's own workspace whichever one the
  // session acts in. A's own workspace is A; D's session acts in A, so its sign-out is recorded in D's workspace.
  const pub = (token: string) => (raw.prepare('SELECT public_id FROM sessions WHERE id = ?').get(hashToken(token)) as { public_id: string }).public_id
  const other = pub(await createSession('A'))
  const revoke = (id: string) => () => sessionsRoute.DELETE(req('/api/auth/sessions', 'DELETE', { id }))
  await step('session signed out', t.A, revoke(other), [['A', 'session.revoked', 'session', other, {}]])
  await step('session signed out twice', t.A, revoke(other), [], 404)
  const dOther = pub(await createSession('D'))
  await step('admin signs out a session of its own: recorded in its own workspace', t.D, revoke(dOther), [['D', 'session.revoked', 'session', dOther, {}]], 200, 'D')
  await createSession('A'); await createSession('A')
  const everywhere = () => revokeAll.POST(post('/api/auth/sessions/revoke-all', {}))
  const ra = await step('signed out everywhere else', t.A, everywhere, [['A', 'session.revoked_all', 'session', null, { sessions: 2, kept_current: true }]])
  assert.deepEqual(await ra.json(), { ok: true, revoked: 2 })
  await step('signed out everywhere else again: none left, nothing recorded', t.A, everywhere, [])

  // ---- account: a changed sign-in address (once the new address's link is opened) and a password reset, neither
  // address nor the password in the trail
  const NEW_EMAIL = 'a-renamed@a-mail.example', NEW_PASSWORD = 'Synthetic-Pass-word-4471!'
  const change = emailToken('A', 'change', NEW_EMAIL)
  await step('email changed', '', () => verifyRoute.POST(post('/api/auth/verify', { token: change })), [['A', 'account.email_changed', 'account', 'A', {}]])
  await step('email change link replayed', '', () => verifyRoute.POST(post('/api/auth/verify', { token: change })), [], 410)
  assert.equal((raw.prepare("SELECT email FROM users WHERE id = 'A'").get() as { email: string }).email, NEW_EMAIL)
  const reset = emailToken('A', 'reset', NEW_EMAIL)
  await step('password reset', '', () => resetRoute.POST(post('/api/auth/reset', { token: reset, password: NEW_PASSWORD })), [['A', 'credential.password_reset', 'account', 'A', {}]])
  await step('password reset link replayed', '', () => resetRoute.POST(post('/api/auth/reset', { token: reset, password: NEW_PASSWORD })), [], 410)
  // the reset signed A out everywhere; A signs in again to read the trail
  assert.notEqual((raw.prepare('SELECT revoked_at FROM sessions WHERE id = ?').get(hashToken(t.A)) as { revoked_at: number | null }).revoked_at, null)
  t.A = await createSession('A')

  // only the stubbed services were called
  assert.deepEqual([...new Set(fetched.map(u => new URL(u).host))].sort(), ['api.hubapi.com', 'api.stripe.com', 'gmail.googleapis.com', 'oauth2.googleapis.com'])

  // the owner's trail view (GET /api/workspace/audit) shows exactly these events, in order
  const r = await read(t.A, '?limit=1000')
  assert.equal(r.status, 200)
  const events = ((await r.json()) as { events: Ev[] }).events.reverse()
  assert.deepEqual(events.map(e => [e.actor_id, e.action, e.resource_type, e.resource_id, e.summary]), all)
  // every action the Covered table names for these areas is among them
  const seen = new Set(events.map(e => `${e.action} ${e.resource_type}`))
  for (const a of ['credential.saved gmail', 'outreach.approve message', 'outreach.send message', 'outreach.skip message', 'outreach.mark_sent message', 'outreach.retry message',
    'autopilot.enable autopilot', 'autopilot.pause autopilot', 'autopilot.resume autopilot', 'autopilot.disable autopilot',
    'sequence.approve sequence', 'sequence.mark_sent sequence', 'sequence.retry sequence', 'sequence.resumed sequences', 'sequence.stop sequence',
    'followups.enabled followups', 'followups.disabled followups', 'consent.accepted reply_reading', 'consent.revoked reply_reading',
    'consent.accepted social', 'consent.revoked social', 'connector.enabled social', 'connector.disabled social', 'credential.saved social', 'credential.removed social',
    'credential.saved crm', 'credential.removed crm', 'crm.pushed lead', 'crm.resolved lead', 'billing.portal_opened plan',
    'pipeline.confirmed lead', 'pipeline.unconfirmed lead', 'monitor.enabled monitor', 'monitor.disabled monitor',
    'reopen.send thread', 'reopen.retry thread', 'reopen.skip thread', 'reopen.mark_sent thread',
    'invitation.created invitation', 'invitation.revoked invitation', 'invitation.accepted invitation', 'member.role_changed member',
    'member.left member', 'member.removed member', 'data.deleted commenter_batch', 'session.revoked session', 'session.revoked_all session',
    'account.email_changed account', 'credential.password_reset account']) assert.ok(seen.has(a), a)
  assert.deepEqual(new Set(events.filter(e => e.action === 'crm.pushed').map(e => e.summary.outcome)), new Set(['failed', 'ok', 'unknown']))

  // the same trail as the owner's CSV download: one row per event, oldest last, each with its actor, action, resource
  // and the correlation id of the request that made it; the download is itself recorded (export.audit)
  const before = top()
  const c = await read(t.A, '?format=csv')
  assert.equal(c.status, 200)
  assert.match(c.headers.get('content-type') ?? '', /text\/csv/)
  const lines = (await c.text()).trim().split('\n')
  assert.equal(lines[0], 'at,actor_id,actor_kind,action,resource_type,resource_id,decision,summary,summary_unreadable,correlation_id')
  const rows = lines.slice(1).map(l => l.match(/("(?:[^"]|"")*"|[^,]*)(,|$)/g)!.map(x => x.replace(/,$/, '')).slice(0, 10))
  assert.equal(rows.length, all.length)
  const dbRows = (raw.prepare("SELECT actor_id, action, resource_type, resource_id, correlation_id FROM audit_events WHERE tenant_id = 'A' AND rowid <= ? ORDER BY at DESC, seq DESC, id DESC").all(before) as Record<string, string | null>[])
  assert.deepEqual(rows.map(r => [r[1], r[3], r[4], r[5] || null, r[9]]), dbRows.map(r => [r.actor_id, r.action, r.resource_type, r.resource_id, r.correlation_id]))
  assert.ok(rows.every(r => /^[0-9a-f-]{36}$/.test(r[9])), 'every row has its request id')
  const csvSeen = new Set(rows.map(r => `${r[3]} ${r[4]}`))
  for (const a of ['invitation.created invitation', 'invitation.revoked invitation', 'invitation.accepted invitation', 'member.role_changed member', 'member.left member',
    'member.removed member', 'data.deleted commenter_batch', 'session.revoked session', 'session.revoked_all session', 'account.email_changed account',
    'credential.password_reset account', 'reopen.send thread', 'reopen.retry thread', 'reopen.skip thread', 'reopen.mark_sent thread']) assert.ok(csvSeen.has(a), `csv: ${a}`)
  assert.deepEqual((raw.prepare('SELECT tenant_id, actor_id, action FROM audit_events WHERE rowid > ?').all(before)), [{ tenant_id: 'A', actor_id: 'A', action: 'export.audit' }])
  // workspace D's own event is D's: A's trail does not show it, and an admin of A cannot ask for it
  assert.ok(!dbRows.some(r => r.resource_id === dOther))
  const dRead = await read(t.D, `?actor=D&limit=1000`)
  assert.ok(!((await dRead.json()) as { events: Ev[] }).events.some(e => e.resource_id === dOther), 'D acting in A sees A\'s trail only')

  // nothing secret, typed or addressed in the trail
  const table = JSON.stringify(raw.prepare('SELECT * FROM audit_events').all())
  for (const [k, v] of Object.entries(MARK)) assert.ok(!table.includes(v), `${k} is not in the trail`)
  for (const v of ['info@lead', 'synthetic monitor query', 'Hiring five roofers', 'synthetic commenter context', 'n@example.test', 'later@example.test',
    NEW_EMAIL, NEW_PASSWORD, ...secrets]) assert.ok(!table.includes(v), `${v} is not in the trail`)
  console.log('AUDIT COVERAGE ok')
})
