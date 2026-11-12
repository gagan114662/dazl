// #803: the email conversation state machine for routine buyer questions (lib/replies/conversation.ts), driven from the
// real reply sync (lib/outreach/replies.ts syncReplies) with a stubbed Gmail. Synthetic data only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { completeOAuth, startOAuth, GMAIL_READ_SCOPE, GmailSendError } from '../lib/gmail/oauth.ts'
import { saveSettings, isSuppressed } from '../lib/outreach/service.ts'
import { ATTESTATIONS, CONSENT_VERSION, enable, getState, migrateAutopilot } from '../lib/outreach/autopilot.ts'
import { migrateLedger } from '../lib/outreach/ledger.ts'
import { acceptReadConsent, migrateReplies, referencedSendIds, syncReplies } from '../lib/outreach/replies.ts'
import { accountSendCount } from '../lib/outreach/send-budget.ts'
import { answerInbound, getAnswerPolicy, inboundAuthenticated, migrateBuyerAnswers, setAnswerPolicy, threadDecisions } from '../lib/replies/conversation.ts'
import type { ProductFacts } from '../lib/replies/buyer-answers.ts'

const master = randomBytes(32)
const genv = { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'cs', PUBLIC_BASE_URL: 'https://app.test' }
const flags = { AUTOPILOT_ENABLED: '1' }
const NOW = 1_800_000_000
const DAY = 86400
const VERSION = 'pt-0123456789abcdef'
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status })
const idToken = (email: string) => 'x.' + Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url') + '.y'
const SEND = 'https://www.googleapis.com/auth/gmail.send'
const FACTS: ProductFacts = {
  version: VERSION,
  pricing: 'Pro is $49 a month (100 scans a month). Runs on your own AI key; the provider bills that usage separately.',
  prerequisites: 'You need a Google account, a Gmail mailbox to send from, and your own OpenAI or Anthropic key.',
  howToStart: 'Sign in with Google, add your own key and describe who you sell to.',
  limitations: 'Email goes from your own Gmail only, at most 20 sends a day per account.',
  signupUrl: 'https://app.test/sign-up', bookingUrl: 'https://cal.example/pat',
  knownIntegrations: ['Gmail', 'HubSpot'],
}

async function setup(o: { policy?: boolean; max?: number; version?: string } = {}) {
  const db = new Database(':memory:'); migrateScan(db); migrateOutreach(db); migrateConnectors(db); migrateAutopilot(db); migrateLedger(db); migrateReplies(db); migrateBuyerAnswers(db)
  const state = new URL(startOAuth(db, 'A', { env: genv, now: NOW, withRead: true })).searchParams.get('state')!
  await completeOAuth(db, 'A', 'c', state, { env: genv, master, now: NOW, fetchImpl: (async () => json({ refresh_token: 'rt', scope: `${SEND} ${GMAIL_READ_SCOPE}`, id_token: idToken('me@acme.example') })) as unknown as typeof fetch })
  saveSettings(db, 'A', { sender_name: 'Pat', postal_address: '1 King St W, Toronto ON M5H 1A1' })
  enable(db, 'A', { version: CONSENT_VERSION, attestations: [...ATTESTATIONS], daily_cap: 5 })
  acceptReadConsent(db, 'A')
  if (o.policy !== false) assert.deepEqual(setAnswerPolicy(db, 'A', { enabled: true, cta: 'signup', maxAutoReplies: o.max ?? 2, acceptedFactsVersion: o.version ?? VERSION }), { ok: true, problems: [] })
  return db
}
function sentLead(db: Database.Database, to: string) {
  const job = createJob(db, 'A', { business_name: 'Acme', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  const lead = randomBytes(12).toString('hex'), mid = randomBytes(12).toString('hex')
  db.prepare('INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(lead, job, 'Northside', to, 'Hiring roofers', 'https://n.example/a', 'Northside is hiring', 90)
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, claimed_at, gmail_id, thread_id) VALUES (?, 'A', ?, ?, 'Quick question', 'bodybodybodybodybodybody', 'sent', ?, ?, ?, ?)").run(mid, lead, to, NOW - 4 * DAY, NOW - 4 * DAY, 'g' + mid, 't' + mid)
  return { lead, mid, thread: 't' + mid }
}
type H = { name: string; value: string }
const AR = (domain: string, authserv = 'mx.google.com') => ({ name: 'Authentication-Results', value: `${authserv}; dkim=pass header.i=@${domain}; spf=pass smtp.mailfrom=${domain}; dmarc=pass (p=NONE) header.from=${domain}` })
const msg = (id: string, from: string, body: string, at: number, extra: H[] = []) => ({ id, threadId: 't', internalDate: String(at * 1000), payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: from }, { name: 'Message-ID', value: `<${id}@mail.example>` }, ...extra], body: { data: Buffer.from(body).toString('base64url') } } })
const question = (id: string, body = "What's the price?", from = 'Lee <lee@co.example>', extra: H[] = [AR('co.example')]) => msg(id, from, body, NOW - DAY, extra)
function gmail(threads: Record<string, unknown[]>) {
  return (async (url: string) => {
    const u = String(url)
    if (u.includes('oauth2')) return json({ access_token: 'at' })
    const m = u.match(/threads\/([^?]+)/); if (m) return json({ messages: threads[m[1]] ?? [] })
    if (u.includes('messages?q=')) return json({ messages: [] })
    return json({}, 404)
  }) as unknown as typeof fetch
}
function sender() {
  const sent: { raw: string; threadId?: string; mime: string }[] = []
  const fn = (async (_t: string, raw: string, _f?: typeof fetch, threadId?: string) => { sent.push({ raw, threadId, mime: Buffer.from(raw, 'base64url').toString('utf8') }); return { id: `s${sent.length}x`, threadId } }) as never
  return { sent, fn }
}
const bodyOf = (mime: string) => Buffer.from(mime.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8')
const sync = (db: Database.Database, threads: Record<string, unknown[]>, sendFn: never, extra: Record<string, unknown> = {}) =>
  syncReplies(db, 'A', { env: genv, master, now: NOW, fetchImpl: gmail(threads), sendFn, flags, facts: FACTS, ...extra })

test('a routine pricing question from the authenticated prospect gets exactly one grounded reply, in the thread', async () => {
  const db = await setup(); const l = sentLead(db, 'lee@co.example'); const s = sender()
  const r = await sync(db, { [l.thread]: [question('in1')] }, s.fn)
  assert.equal(r.error, undefined)
  assert.equal(s.sent.length, 1)
  assert.equal(s.sent[0].threadId, l.thread)
  const mime = s.sent[0].mime, body = bodyOf(mime)
  assert.match(mime, /^To: lee@co\.example\r$/m)
  assert.match(mime, /^Subject: Re: Quick question\r$/m)
  assert.match(mime, /^In-Reply-To: <in1@mail\.example>\r$/m)
  assert.match(mime, new RegExp(`^Message-ID: <dazl\\.a0\\.${l.mid}@acme\\.example>\\r$`, 'm'))
  assert.ok(body.includes(FACTS.pricing), 'the answer is the approved pricing fact')
  assert.ok(body.includes('https://app.test/sign-up'), 'signup CTA from the facts')
  assert.ok(body.includes('unsubscribe here: https://app.test/api/unsubscribe?t='), 'the standard footer with unsubscribe')
  assert.ok(!body.includes("What's the price"), 'the inbound text is never copied into the reply')
  const d = threadDecisions(db, 'A', l.thread)
  assert.deepEqual(d.map(x => [x.gmail_id, x.action, x.status, x.topics]), [['in1', 'reply', 'sent', 'pricing']])
  // a bounce of the answer correlates to the original send like every other dazl id
  assert.deepEqual(referencedSendIds([`<dazl.a0.${l.mid}@acme.example>`], 'acme.example'), [l.mid])
  // nothing of the inbound body is stored by the decision
  const row = JSON.stringify(db.prepare('SELECT * FROM buyer_answer_decisions').all())
  assert.ok(!row.includes('price?'))
  assert.equal(accountSendCount(db, 'A', NOW), 1) // the answer counts against the shared daily cap (the original went out 4 days ago)
})

test('duplicates send once: a second sync, a re-delivered inbound and two concurrent decisions on one message', async () => {
  const db = await setup(); const l = sentLead(db, 'lee@co.example'); const s = sender()
  const threads = { [l.thread]: [question('in1')] }
  await sync(db, threads, s.fn)
  await sync(db, threads, s.fn)
  assert.equal(s.sent.length, 1, 'second sync: already handled')
  // the inbound log row is lost (a retry from scratch): the decision row still stops a second answer
  db.prepare('DELETE FROM inbound_messages').run()
  await sync(db, threads, s.fn)
  assert.equal(s.sent.length, 1, 're-delivered message: ignored')
  // two deliveries of the same new message racing each other
  const q = question('in2', 'How do I get started?')
  const input = { threadId: l.thread, prospect: 'lee@co.example', leadId: l.lead, outreachMessageId: l.mid, rootMessageId: `dazl.${l.mid}@acme.example`, subject: 'Quick question', tenantWroteInThread: false, cls: 'other' as const, inbound: { gmailId: 'in2', from: 'lee@co.example', text: 'How do I get started?', payload: q.payload } }
  const deps = { env: genv, master, now: NOW, fetchImpl: gmail({}), sendFn: s.fn, flags, facts: FACTS }
  const [a, b] = await Promise.all([answerInbound(db, 'A', input, deps), answerInbound(db, 'A', input, deps)])
  assert.deepEqual([a.outcome, b.outcome].sort(), ['ignore', 'sent'])
  assert.equal(s.sent.length, 2)
  assert.equal((db.prepare("SELECT count(*) AS n FROM buyer_answer_decisions WHERE gmail_id = 'in2'").get() as { n: number }).n, 1)
})

test('user takeover pauses automation for the thread, and it stays paused', async () => {
  const db = await setup(); const l = sentLead(db, 'lee@co.example'); const s = sender()
  const mine = msg('me1', 'Pat <me@acme.example>', 'Happy to walk you through it myself.', NOW - DAY + 10)
  await sync(db, { [l.thread]: [question('in1'), mine] }, s.fn)
  assert.equal(s.sent.length, 0)
  assert.deepEqual(threadDecisions(db, 'A', l.thread).map(x => [x.action, x.status]), [['pause', 'recorded']])
  // the tenant's message is gone from the thread view later: a new routine question in it is still not answered
  await sync(db, { [l.thread]: [question('in1'), question('in3', 'How much does it cost?')] }, s.fn)
  assert.equal(s.sent.length, 0)
  assert.deepEqual(threadDecisions(db, 'A', l.thread).map(x => x.action), ['pause', 'pause'])
  // an opt-out in a taken-over thread still suppresses (the existing sync suppression, recorded as such)
  await sync(db, { [l.thread]: [question('in4', 'Please remove me from your list')] }, s.fn)
  assert.equal(isSuppressed(db, 'A', 'lee@co.example'), true)
  assert.equal(threadDecisions(db, 'A', l.thread).at(-1)!.action, 'suppress')
})

test("dazl's own messages in the thread are not a takeover (follow-up ids, recorded sends)", async () => {
  const db = await setup(); const l = sentLead(db, 'lee@co.example'); const s = sender()
  const ours = { ...msg('f1', 'Pat <me@acme.example>', 'following up', NOW - 2 * DAY), payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'Pat <me@acme.example>' }, { name: 'Message-ID', value: `<dazl.f0.${l.mid}@acme.example>` }], body: { data: '' } } }
  const original = msg('g' + l.mid, 'Pat <me@acme.example>', 'the original', NOW - 4 * DAY) // its Gmail id is the recorded send
  await sync(db, { [l.thread]: [original, ours, question('in1')] }, s.fn)
  assert.equal(s.sent.length, 1)
  // a lookalike id on another domain is the tenant writing (not dazl's)
  const db2 = await setup(); const l2 = sentLead(db2, 'lee@co.example'); const s2 = sender()
  const fake = { ...ours, id: 'x1', payload: { ...ours.payload, headers: [{ name: 'From', value: 'Pat <me@acme.example>' }, { name: 'Message-ID', value: `<dazl.f0.${l2.mid}@evil.example>` }] } }
  await sync(db2, { [l2.thread]: [fake, question('in1')] }, s2.fn)
  assert.equal(s2.sent.length, 0)
})

test('thread identity: only the prospect, with DMARC pass in the first Authentication-Results for its own domain', async () => {
  const cases: [string, ReturnType<typeof question>][] = [
    ['no authentication results', question('a1', "What's the price?", 'lee@co.example', [])],
    ['another person at the company', question('a2', "What's the price?", 'sam@co.example', [AR('co.example')])],
    ['dmarc for another domain', question('a3', "What's the price?", 'lee@co.example', [AR('evil.example')])],
    ['untrusted first header, trusted one below it', question('a4', "What's the price?", 'lee@co.example', [AR('co.example', 'relay.evil.example'), AR('co.example')])],
    ['dmarc fail', question('a5', "What's the price?", 'lee@co.example', [{ name: 'Authentication-Results', value: 'mx.google.com; dmarc=fail header.from=co.example' }])],
    ['subdomain is not the domain', question('a6', "What's the price?", 'lee@co.example', [AR('mail.co.example')])],
  ]
  for (const [name, q] of cases) {
    const db = await setup(); const l = sentLead(db, 'lee@co.example'); const s = sender()
    await sync(db, { [l.thread]: [q] }, s.fn)
    assert.equal(s.sent.length, 0, name)
    const d = threadDecisions(db, 'A', l.thread)
    assert.deepEqual(d.map(x => [x.action, x.reason]), [['escalate', 'unauthenticated']], name)
  }
  assert.equal(inboundAuthenticated(undefined, 'lee@co.example', 'lee@co.example'), false)
  assert.equal(inboundAuthenticated({ headers: [AR('co.example')] }, 'LEE@CO.EXAMPLE', 'lee@co.example'), true)
  assert.equal(inboundAuthenticated({ headers: [{ name: 'Authentication-Results', value: 'mx.google.com; dmarc=pass' }] }, 'lee@co.example', 'lee@co.example'), false)
  assert.equal(inboundAuthenticated({ headers: [AR('co.example')] }, '', ''), false)
})

test('off by default: no policy, no decision rows, no send; the existing sync is unchanged', async () => {
  const db = await setup({ policy: false }); const l = sentLead(db, 'lee@co.example'); const s = sender()
  assert.deepEqual(getAnswerPolicy(db, 'A'), { enabled: false, cta: 'signup', maxAutoReplies: 2, acceptedFactsVersion: null })
  const r = await sync(db, { [l.thread]: [question('in1')] }, s.fn)
  assert.equal(r.replies, 1)
  assert.equal(s.sent.length, 0)
  assert.deepEqual(threadDecisions(db, 'A', l.thread), [])
})

test('within policy: facts version, per-thread maximum, meeting CTA, automation switches', async () => {
  // the record changed since the owner accepted it: nothing is answered
  { const db = await setup({ version: 'pt-ffffffffffffffff' }); const l = sentLead(db, 'lee@co.example'); const s = sender()
    await sync(db, { [l.thread]: [question('in1')] }, s.fn)
    assert.equal(s.sent.length, 0); assert.equal(threadDecisions(db, 'A', l.thread)[0].reason, 'facts_stale') }
  // max one answer per thread
  { const db = await setup({ max: 1 }); const l = sentLead(db, 'lee@co.example'); const s = sender()
    await sync(db, { [l.thread]: [question('in1')] }, s.fn)
    await sync(db, { [l.thread]: [question('in1'), question('in2', 'How do I get started?')] }, s.fn)
    assert.equal(s.sent.length, 1); assert.equal(threadDecisions(db, 'A', l.thread)[1].reason, 'reply_limit') }
  // meeting CTA uses the booking link
  { const db = await setup(); setAnswerPolicy(db, 'A', { enabled: true, cta: 'meeting', maxAutoReplies: 2, acceptedFactsVersion: VERSION }); const l = sentLead(db, 'lee@co.example'); const s = sender()
    await sync(db, { [l.thread]: [question('in1')] }, s.fn)
    assert.ok(bodyOf(s.sent[0].mime).includes('https://cal.example/pat')) }
  // deployment switch off, tenant autopilot paused: the decision is held, nothing goes out
  for (const [why, prep, extra] of [
    ['not_available', () => {}, { flags: {} }],
    ['paused', (db: Database.Database) => db.prepare("UPDATE autopilot_settings SET paused = 1, pause_reason = 'paused_by_user'").run(), {}],
    ['autopilot_off', (db: Database.Database) => db.prepare('UPDATE autopilot_settings SET enabled = 0').run(), {}],
  ] as [string, (db: Database.Database) => void, Record<string, unknown>][]) {
    const db = await setup(); const l = sentLead(db, 'lee@co.example'); const s = sender(); prep(db)
    await sync(db, { [l.thread]: [question('in1')] }, s.fn, extra)
    assert.equal(s.sent.length, 0, why)
    assert.deepEqual(threadDecisions(db, 'A', l.thread).map(x => [x.status, x.reason]), [['held', why]], why)
  }
  // daily cap: the answer claim counts and refuses past the cap
  { const db = await setup(); db.prepare('UPDATE autopilot_settings SET daily_cap = 1').run(); const l = sentLead(db, 'lee@co.example'); const s = sender()
    db.prepare('UPDATE outreach_messages SET claimed_at = ?').run(NOW - 60) // one send already in the last 24 hours
    await sync(db, { [l.thread]: [question('in1')] }, s.fn)
    assert.equal(s.sent.length, 0); assert.equal(threadDecisions(db, 'A', l.thread)[0].reason, 'daily_cap') }
})

test('send outcomes: a definite refusal is held, an unknown outcome is uncertain and pauses sending; never retried', async () => {
  { const db = await setup(); const l = sentLead(db, 'lee@co.example')
    const refuse = (async () => { throw new GmailSendError(500) }) as never
    await sync(db, { [l.thread]: [question('in1')] }, refuse)
    assert.deepEqual(threadDecisions(db, 'A', l.thread).map(x => [x.status, x.reason]), [['held', 'gmail_500']])
    assert.equal(getState(db, 'A').paused, false) }
  { const db = await setup(); const l = sentLead(db, 'lee@co.example'); let calls = 0
    const unknown = (async () => { calls++; throw new Error('socket hang up') }) as never
    await sync(db, { [l.thread]: [question('in1')] }, unknown)
    assert.deepEqual(threadDecisions(db, 'A', l.thread).map(x => x.status), ['uncertain'])
    assert.equal(getState(db, 'A').pause_reason, 'uncertain_send')
    assert.equal(getState(db, 'A').paused, true)
    await sync(db, { [l.thread]: [question('in1')] }, unknown)
    assert.equal(calls, 1) }
  { const db = await setup(); const l = sentLead(db, 'lee@co.example')
    const bad = (async () => ({ id: '' })) as never // a 2xx without a usable id is not a confirmed handoff
    await sync(db, { [l.thread]: [question('in1')] }, bad)
    assert.deepEqual(threadDecisions(db, 'A', l.thread).map(x => x.status), ['uncertain']) }
})

test('escalations and stops are recorded, never answered: opt-out, unknown integration, discount, unclear reply', async () => {
  const cases: [string, string, string | null][] = [
    ['Please unsubscribe me', 'suppress', null],
    ['Does it work with Salesforce?', 'escalate', 'unknown_integration'],
    ['Can I get a discount on the price?', 'escalate', 'authority'],
    ['stop', 'escalate', 'negative'],
    ['Not interested', 'escalate', 'negative'],
  ]
  for (const [text, action, reason] of cases) {
    const db = await setup(); const l = sentLead(db, 'lee@co.example'); const s = sender()
    await sync(db, { [l.thread]: [question('in1', text)] }, s.fn)
    assert.equal(s.sent.length, 0, text)
    assert.deepEqual(threadDecisions(db, 'A', l.thread).map(x => [x.action, x.reason]), [[action, reason]], text)
  }
})

test('setAnswerPolicy: on needs the accepted facts version; malformed values are refused by name and change nothing', async () => {
  const db = await setup({ policy: false })
  assert.deepEqual(setAnswerPolicy(db, 'A', { enabled: true }), { ok: false, problems: ['facts_version_required'] })
  assert.deepEqual(setAnswerPolicy(db, 'A', { enabled: true, acceptedFactsVersion: 'latest' }).problems, ['facts_version_invalid'])
  assert.deepEqual(setAnswerPolicy(db, 'A', { enabled: true, acceptedFactsVersion: ['pt-0123456789abcdef'] }).problems, ['facts_version_invalid'])
  assert.deepEqual(setAnswerPolicy(db, 'A', { enabled: true, acceptedFactsVersion: VERSION, cta: 'call' }).problems, ['cta_invalid'])
  for (const max of [0, 6, 1.5, '2', null]) assert.deepEqual(setAnswerPolicy(db, 'A', { enabled: true, acceptedFactsVersion: VERSION, maxAutoReplies: max }).problems, ['max_invalid'], String(max))
  assert.equal(getAnswerPolicy(db, 'A')!.enabled, false)
  // a truthy non-boolean is not "on"
  assert.deepEqual(setAnswerPolicy(db, 'A', { enabled: 'yes', acceptedFactsVersion: VERSION }), { ok: true, problems: [] })
  assert.equal(getAnswerPolicy(db, 'A')!.enabled, false)
  // a tenant with no automation settings row
  assert.deepEqual(setAnswerPolicy(db, 'B', { enabled: true, acceptedFactsVersion: VERSION }).problems, ['no_automation_settings'])
  // the store refuses out-of-range values written around the setter
  assert.throws(() => db.prepare("UPDATE autopilot_settings SET answers_cta = 'call'").run())
  assert.throws(() => db.prepare('UPDATE autopilot_settings SET answers_max = 9').run())
})

test("answerInbound: malformed input records nothing and never sends; another tenant's decisions are invisible", async () => {
  const db = await setup(); const l = sentLead(db, 'lee@co.example'); const s = sender()
  const base = { threadId: l.thread, prospect: 'lee@co.example', leadId: l.lead, outreachMessageId: l.mid, rootMessageId: `dazl.${l.mid}@acme.example`, subject: 'Quick question', tenantWroteInThread: false, cls: 'other' as const }
  const deps = { env: genv, master, now: NOW, fetchImpl: gmail({}), sendFn: s.fn, flags, facts: FACTS }
  for (const gmailId of ['', 'a b', 'x'.repeat(200), 42, null] as unknown as string[])
    assert.equal((await answerInbound(db, 'A', { ...base, inbound: { gmailId, from: 'lee@co.example', text: "What's the price?", payload: question('q').payload } }, deps)).outcome, 'off')
  assert.equal((await answerInbound(db, 'A', { ...base, threadId: '', inbound: { gmailId: 'ok1', from: 'lee@co.example', text: "What's the price?", payload: question('q').payload } }, deps)).outcome, 'off')
  // a non-string body is no question
  const r = await answerInbound(db, 'A', { ...base, inbound: { gmailId: 'ok2', from: 'lee@co.example', text: { evil: 1 } as unknown as string, payload: question('q').payload } }, deps)
  assert.deepEqual(r, { outcome: 'recorded', action: 'escalate', reason: 'negative' }) // an empty body reads as unclear: the owner looks
  assert.equal(s.sent.length, 0)
  assert.deepEqual(threadDecisions(db, 'B', l.thread), [])
})
