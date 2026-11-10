// #192 owner-authorised scope (2026-11-06): the signed-in session transport and the reader's session plan. Invented data, a fake worker; no network, no LinkedIn call.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { bothEngines } from './helpers/engines.ts'
import { collectLinkedInPeople, DAY_CONNECTOR, MAX_REQUESTS_PER_HOUR, MIN_GAP_MS, sessionLimits, type LinkedInTransport, type TransportRequest, type TransportResult } from '../lib/signals/linkedin-people.ts'
import { linkedinSessionTransport, mapOutcome, parseReply, readReply, sessionTransportEnabled, sessionTransportProblem } from '../lib/signals/linkedin-session-transport.ts'
import { writeConsent } from '../lib/advanced/index.ts'
import { setCompetitors } from '../lib/signals/competitor-reddit.ts'
import { connectorStatus, setEnabled, writeCredential } from '../lib/connectors/store.ts'
import { requestsInWindow } from '../lib/advanced/request-budget.ts'
import type { Db } from '../lib/db/client.ts'

const ICP = { who: ['HR manager'], where: ['Ohio'], industries: ['SaaS'] }
const ENV = { ADVANCED_CONNECTORS: '1', ADVANCED_LINKEDIN: '1', ADVANCED_LINKEDIN_PEOPLE: '1' }
const T_ENV = { LINKEDIN_SESSION_TRANSPORT: '1', LINKEDIN_SESSION_TENANTS: 'A', LINKEDIN_SESSION_ACCOUNT: 'throwaway-li@example.test', ADVANCED_WORKER_URL: 'http://worker', ADVANCED_WORKER_TOKEN: 'tok' }
const POST = 'https://www.linkedin.com/feed/update/urn:li:activity:7391234567890123456/'
const NOW = Math.floor(Date.now() / 1000)
const MASTER = randomBytes(32)
const person = (id: string) => ({ url: `https://www.linkedin.com/in/${id}`, title: id, quote: `Commented on ${POST}: "${id} is evaluating alternatives"`, date: '2026-10-20' })
async function ready(db: Db, tenant = 'A') { await writeConsent(db, tenant, 'linkedin'); await setCompetitors(db, tenant, ['Rippling', 'Gusto']) }
const audits = async (db: Db) => (await db.all<{ connector: string; status: string; lookup: string }>("SELECT connector, status, lookup FROM connector_audit WHERE tenant_id = 'A' AND connector = 'adv:linkedin' ORDER BY insert_seq")).map(a => `${a.lookup.split(':')[0]}:${a.status}`)
function sessionFake(answer: (r: TransportRequest) => TransportResult) { const seen: TransportRequest[] = []; const t: LinkedInTransport = { session: true, fetch: async r => { seen.push(r); return answer(r) } }; return { t, seen } }
const answers = (r: TransportRequest): TransportResult => r.kind === 'posts' ? { status: 'ok', items: [{ url: POST, title: 'post', quote: 'Rippling announces a new payroll product line', date: null }] } : { status: 'ok', items: [person(`${r.kind}-1`), person('both-2')] }

test('the session transport is OFF unless its flag, ONE allowlisted tenant, a named throwaway account and the worker settings are all set', () => {
  assert.equal(sessionTransportProblem('A', {}), 'off', 'off by default: no env, no transport')
  assert.equal(sessionTransportEnabled('A', { ...T_ENV, LINKEDIN_SESSION_TRANSPORT: '0' }), false)
  assert.equal(sessionTransportEnabled('A', { ...T_ENV, LINKEDIN_SESSION_TRANSPORT: 'true' }), false, 'only the exact value 1 turns it on')
  assert.equal(sessionTransportProblem('B', T_ENV), 'not_allowlisted', 'a tenant that is not allowlisted never uses the session')
  assert.equal(sessionTransportProblem('A', { ...T_ENV, ADVANCED_WORKER_TOKEN: '' }), 'no_worker')
  assert.equal(sessionTransportEnabled('A', T_ENV), true)
  assert.equal(sessionTransportEnabled('A', { ...T_ENV, LINKEDIN_SESSION_TENANTS: ' A , A ' }), true, 'the same tenant twice is one tenant')
  // #949 review: the caps are per tenant, so two tenants holding the one throwaway session would double its hourly and daily volume. Two or more = off for everyone.
  assert.equal(sessionTransportProblem('A', { ...T_ENV, LINKEDIN_SESSION_TENANTS: ' X, A ' }), 'multiple_tenants')
  assert.equal(sessionTransportProblem('X', { ...T_ENV, LINKEDIN_SESSION_TENANTS: 'X,A' }), 'multiple_tenants')
  assert.equal(sessionTransportProblem('A', { ...T_ENV, LINKEDIN_SESSION_TENANTS: '' }), 'not_allowlisted')
  // the dedicated throwaway account must be named (the operator's attestation); a cookie pasted there is refused, never echoed
  for (const account of [undefined, '', '  ', 'ab', 'x'.repeat(201), 'li_at=AQEDsecret', 'JSESSIONID="ajax:1"', 'a; b', 'two words']) {
    assert.equal(sessionTransportProblem('A', { ...T_ENV, LINKEDIN_SESSION_ACCOUNT: account }), 'no_account', String(account))
  }
})

test('worker failures map to named stops; an unsupported, error or malformed reply is an error, never zero results', () => {
  assert.deepEqual(mapOutcome('challenge'), { status: 'challenge' }); assert.deepEqual(mapOutcome('auth_failed'), { status: 'unauthorized' })
  assert.deepEqual(mapOutcome('throttled'), { status: 'throttled' }); assert.deepEqual(mapOutcome('schema_error'), { status: 'error' })
  assert.deepEqual(parseReply({ items: [], outcome: 'unsupported' }, 25), { status: 'error' }); assert.deepEqual(parseReply({ error: 'x', items: [] }, 25), { status: 'error' })
  assert.deepEqual(parseReply({ items: [] }, 25), { status: 'ok', items: [], upstream_requests: 1 })
  assert.equal((parseReply({ items: [], upstream_requests: 2 }, 25) as { upstream_requests: number }).upstream_requests, 2, 'a worker that reports two upstream requests is passed through, so the reader stops on the contract')
})

bothEngines('transport: reads the stored session, one worker request per call, posts via /linkedin/posts, engagers via /linkedin/engagers; no session = no request', async ({ db }) => {
  const calls: { url: string; body: Record<string, unknown> }[] = []
  let reply: { status: number; body: unknown } = { status: 200, body: { items: [person('x-1')], upstream_requests: 1 } }
  const fetchImpl = (async (url: string, init: RequestInit) => { calls.push({ url, body: JSON.parse(String(init.body)) }); return new Response(JSON.stringify(reply.body), { status: reply.status }) }) as typeof fetch
  const t = linkedinSessionTransport(db, { env: T_ENV, master: MASTER, fetchImpl })
  const req = (kind: TransportRequest['kind'], query: string): TransportRequest => ({ kind, query, tenantId: 'A', maxItems: 25, signal: new AbortController().signal })
  assert.deepEqual(await t.fetch(req('commenters', POST)), { status: 'unauthorized' }); assert.equal(calls.length, 0, 'no stored session: nothing is requested')
  await writeCredential(db, 'A', 'adv:linkedin', 'li_at=THROWAWAY; JSESSIONID="ajax:1"', MASTER)
  const r = await t.fetch(req('commenters', POST))
  assert.equal(r.status, 'ok'); assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'http://worker/linkedin/engagers'); assert.deepEqual(calls[0].body, { kind: 'commenters', post: POST, session: 'li_at=THROWAWAY; JSESSIONID="ajax:1"' })
  await t.fetch(req('posts', 'Rippling'))
  assert.equal(calls[1].url, 'http://worker/linkedin/posts', 'the post search uses the classifying session route, not the generic /fetch adapter'); assert.deepEqual({ ...calls[1].body, session: '-' }, { query: 'Rippling', session: '-' })
  reply = { status: 502, body: { error: 'fetch_failed', outcome: 'challenge' } }
  assert.deepEqual(await t.fetch(req('reactors', POST)), { status: 'challenge' })
  assert.deepEqual(await t.fetch(req('people', 'HR manager')), { status: 'error' }, 'the session transport only reads posts and engagers'); assert.equal(calls.length, 3)
  assert.deepEqual(await t.fetch({ ...req('commenters', POST), tenantId: 'B' }), { status: 'unauthorized' }, 'a non-allowlisted tenant'); assert.equal(calls.length, 3)
})

bothEngines('session plan: competitor post search, then that post\'s commenters and reactors, paced, deduplicated profiles only', async ({ db }) => {
  await ready(db)
  const { t, seen } = sessionFake(answers); const slept: number[] = []
  const out = await collectLinkedInPeople(db, 'A', 'j', ICP, { transport: t, env: { ...ENV, LINKEDIN_SESSION_GAP_MS: '15000' }, now: NOW, sleep: async ms => { slept.push(ms) } })
  assert.deepEqual(seen.map(r => `${r.kind}:${r.query}`), ['posts:Rippling', `commenters:${POST}`, `reactors:${POST}`], 'one competitor fully read within the per-run cap of 3')
  assert.deepEqual(out.map(i => i.url), ['https://www.linkedin.com/in/commenters-1', 'https://www.linkedin.com/in/both-2', 'https://www.linkedin.com/in/reactors-1'])
  assert.ok(out.every(i => i.login_walled && i.quote.length > 0 && i.url.startsWith('https://www.linkedin.com/in/')), 'review lane, with a quote that carries the post link')
  assert.equal(slept.length, 2); assert.ok(slept.every(ms => ms >= 15000 && ms <= 22500), 'a human pace between session requests, with jitter')
  assert.deepEqual(await audits(db), ['posts:ok', 'commenters:ok', 'reactors:ok'])
  assert.equal(await requestsInWindow(db, 'A', 'adv:linkedin', NOW), 3); assert.equal(await requestsInWindow(db, 'A', DAY_CONNECTOR, NOW), 3)
})

bothEngines('session stops: a checkpoint/captcha stops the run at once, is audited and reported, and cools the tenant down', async ({ db }) => {
  await ready(db)
  const { t, seen } = sessionFake(r => r.kind === 'posts' ? answers(r) : { status: 'challenge' })
  const stops: string[] = []
  assert.deepEqual(await collectLinkedInPeople(db, 'A', 'j', ICP, { transport: t, env: ENV, now: NOW, sleep: async () => {}, onStop: s => stops.push(s) }), [])
  assert.equal(seen.length, 2, 'no retry, no reactors call after the challenge'); assert.deepEqual(stops, ['stopped_challenge'])
  assert.deepEqual(await audits(db), ['posts:ok', 'commenters:stopped_challenge', 'commenters:session_disabled'])
  assert.deepEqual(await collectLinkedInPeople(db, 'A', 'j2', ICP, { transport: t, env: ENV, now: NOW + 60, sleep: async () => {} }), []); assert.equal(seen.length, 2, 'cooldown: nothing requested')
})

bothEngines('session caps: the daily cap stops visibly; the per-run cap never exceeds the shared hourly cap; a post search with no post yields no engager calls', async ({ db }) => {
  await ready(db)
  assert.equal(sessionLimits({ LINKEDIN_SESSION_PER_RUN: '50' }).perRun, MAX_REQUESTS_PER_HOUR)
  assert.equal(sessionLimits({}).daily, 6); assert.equal(sessionLimits({ LINKEDIN_ENGAGERS_DAILY_CAP: '-1' }).daily, 6); assert.equal(sessionLimits({ LINKEDIN_ENGAGERS_DAILY_CAP: '999' }).daily, 50)
  const stops: string[] = []
  const { t, seen } = sessionFake(answers)
  await collectLinkedInPeople(db, 'A', 'j', ICP, { transport: t, env: { ...ENV, LINKEDIN_ENGAGERS_DAILY_CAP: '2' }, now: NOW, sleep: async () => {}, onStop: s => stops.push(s) })
  assert.equal(seen.length, 2, 'the third request is refused by the daily cap'); assert.deepEqual(stops, ['daily_cap'])
  // two hours later the hourly window is clear but the day is not
  await collectLinkedInPeople(db, 'A', 'j2', ICP, { transport: t, env: { ...ENV, LINKEDIN_ENGAGERS_DAILY_CAP: '2' }, now: NOW + 7200, sleep: async () => {}, onStop: s => stops.push(s) })
  assert.equal(seen.length, 2, 'still capped for the day'); assert.deepEqual(stops, ['daily_cap', 'daily_cap'])
  const none = sessionFake(r => r.kind === 'posts' ? { status: 'ok', items: [] } : answers(r))
  await ready(db, 'C'); await collectLinkedInPeople(db, 'C', 'j', ICP, { transport: none.t, env: ENV, now: NOW, sleep: async () => {} })
  assert.deepEqual(none.seen.map(r => r.kind), ['posts', 'posts'], 'no post found: the next competitor is searched, no engager call without a post')
})

test('human pace: the gap between session requests never goes below MIN_GAP_MS, whatever the configuration', () => {
  assert.equal(MIN_GAP_MS, 10_000)
  assert.equal(sessionLimits({}).gapMs, 20_000)
  for (const v of ['0', '1', '9999', '-5', 'abc', '1e3', '']) assert.equal(sessionLimits({ LINKEDIN_SESSION_GAP_MS: v }).gapMs >= MIN_GAP_MS, true, v)
  assert.equal(sessionLimits({ LINKEDIN_SESSION_GAP_MS: '999999999' }).gapMs, 600_000)
  for (const v of ['1.5', 'NaN', '-1', '[]']) { assert.equal(sessionLimits({ LINKEDIN_ENGAGERS_DAILY_CAP: v }).daily, 6, v); assert.equal(sessionLimits({ LINKEDIN_SESSION_PER_RUN: v }).perRun, 3, v) }
})

bothEngines('ban signal: a challenge or a logged-out answer on the throwaway session switches the connector OFF until an operator re-enables it; a throttle only cools down', async ({ db }) => {
  for (const [tenant, status, off] of [['A', 'challenge', true], ['D', 'unauthorized', true], ['E', 'throttled', false]] as const) {
    await ready(db, tenant); await writeCredential(db, tenant, 'adv:linkedin', 'li_at=THROWAWAY; JSESSIONID="ajax:1"', MASTER)
    const { t, seen } = sessionFake(r => r.kind === 'posts' ? answers(r) : { status })
    await collectLinkedInPeople(db, tenant, 'j', ICP, { transport: t, env: ENV, now: NOW, sleep: async () => {} })
    assert.equal(seen.length, 2, status)
    assert.equal((await connectorStatus(db, tenant)).find(c => c.connector === 'adv:linkedin')?.enabled, !off, `${status}: connector ${off ? 'off' : 'still on'}`)
    // a day later the cooldown is over; a switched-off connector still requests nothing and says why
    const later = sessionFake(answers)
    await collectLinkedInPeople(db, tenant, 'j2', ICP, { transport: later.t, env: ENV, now: NOW + 2 * 86_400, sleep: async () => {} })
    assert.equal(later.seen.length, off ? 0 : 3, status)
    if (off) {
      assert.ok((await db.all<{ status: string }>("SELECT status FROM connector_audit WHERE tenant_id = ? AND connector = 'adv:linkedin-people'", [tenant])).some(r => r.status === 'connector_disabled'))
      await setEnabled(db, tenant, 'adv:linkedin', true)   // the operator checked the account and switched it back on
      const again = sessionFake(answers)
      await collectLinkedInPeople(db, tenant, 'j3', ICP, { transport: again.t, env: ENV, now: NOW + 3 * 86_400, sleep: async () => {} }); assert.equal(again.seen.length, 3)
    }
  }
})

bothEngines('ownership after the pace: a scan stopped during the human-pace wait sends no further request and reserves nothing (#949 review)', async ({ db }) => {
  await ready(db)
  let owned = true
  const { t, seen } = sessionFake(answers)
  class Stopped extends Error {}
  await assert.rejects(collectLinkedInPeople(db, 'A', 'j', ICP, { transport: t, env: ENV, now: NOW, sleep: async () => { owned = false }, beforeRequest: () => { if (!owned) throw new Stopped() } }), Stopped)
  assert.deepEqual(seen.map(r => r.kind), ['posts'], 'cancelled while pacing: the commenters call is never sent')
  assert.equal(await requestsInWindow(db, 'A', 'adv:linkedin', NOW), 1); assert.equal(await requestsInWindow(db, 'A', DAY_CONNECTOR, NOW), 1)
})

bothEngines('no credential in logs: the session cookie never reaches console output, on success or on any failure path', async ({ db }) => {
  const COOKIE = 'li_at=SECRETCOOKIE123; JSESSIONID="ajax:SECRET"'
  await ready(db); await writeCredential(db, 'A', 'adv:linkedin', COOKIE, MASTER)
  const logged: string[] = [], saved = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug }
  for (const k of Object.keys(saved) as (keyof typeof saved)[]) console[k] = (...a: unknown[]) => { logged.push(a.map(x => { try { return typeof x === 'string' ? x : JSON.stringify(x) ?? String(x) } catch { return String(x) } }).join(' ')) }
  try {
    const replies: (() => Response)[] = [
      () => new Response(JSON.stringify({ items: [{ url: POST, title: 'p', quote: 'Rippling announces a new payroll product line', date: null }], upstream_requests: 1 })),
      () => { throw new Error(`network down while sending ${COOKIE}`) },
      () => new Response('not json', { status: 200 }),
      () => new Response(JSON.stringify({ error: 'fetch_failed', outcome: 'challenge' }), { status: 502 }),
    ]
    for (const reply of replies) {
      const t = linkedinSessionTransport(db, { env: T_ENV, master: MASTER, fetchImpl: (async () => reply()) as typeof fetch })
      await t.fetch({ kind: 'posts', query: 'Rippling', tenantId: 'A', maxItems: 25, signal: new AbortController().signal })
    }
  } finally { Object.assign(console, saved) }
  assert.ok(!logged.some(l => /SECRETCOOKIE|ajax:SECRET/.test(l)), JSON.stringify(logged))
  const rows = await db.all<{ lookup: string; status: string }>("SELECT lookup, status FROM connector_audit WHERE tenant_id = 'A'")
  assert.ok(!rows.some(r => /SECRETCOOKIE|ajax:SECRET/.test(`${r.lookup} ${r.status}`)), 'nor in the audit trail')
})

test('worker replies are streamed with a byte cap: an oversized reply is an error, never buffered whole (#949 review)', async () => {
  let pulled = 0, cancelled = false
  const huge = new ReadableStream<Uint8Array>({ pull(c) { pulled++; if (pulled > 10_000) { c.close(); return } c.enqueue(new Uint8Array(64 * 1024).fill(0x20)) }, cancel() { cancelled = true } })
  assert.equal(await readReply(new Response(huge)), null); assert.ok(cancelled); assert.ok(pulled < 40, String(pulled))
  assert.equal(await readReply(new Response('{"items":[]}')), '{"items":[]}')
  assert.equal(await readReply(new Response(null, { status: 204 })), '')
  assert.equal(await readReply(new Response('x'.repeat(11)), 10), null)
})

bothEngines('transport: an oversized, malformed, non-object or wrong-typed worker reply is an error, never results', async ({ db }) => {
  await writeCredential(db, 'A', 'adv:linkedin', 'li_at=T; JSESSIONID="ajax:1"', MASTER)
  const req: TransportRequest = { kind: 'commenters', query: POST, tenantId: 'A', maxItems: 25, signal: new AbortController().signal }
  for (const body of ['x'.repeat(1_000_001), '', 'null', '[]', '7', '"s"', '{"items":"x"}', '{"items":null}', '{}', '\u0000\uffff']) {
    const t = linkedinSessionTransport(db, { env: T_ENV, master: MASTER, fetchImpl: (async () => new Response(body)) as typeof fetch })
    assert.deepEqual(await t.fetch(req), { status: 'error' }, body.slice(0, 20))
  }
  const typed = linkedinSessionTransport(db, { env: T_ENV, master: MASTER, fetchImpl: (async () => new Response(JSON.stringify({ items: [null, 1, 'x', { url: 'javascript:alert(1)', title: 't', quote: 'q' }, { url: 'https://www.linkedin.com/in/ok-1', title: 7, quote: 'q' }, { url: 'https://www.linkedin.com/in/ok-2', title: 't', quote: 'q', date: '20-10-2026' }] }))) as typeof fetch })
  assert.deepEqual(await typed.fetch(req), { status: 'ok', items: [{ url: 'https://www.linkedin.com/in/ok-2', title: 't', quote: 'q', date: null }], upstream_requests: 1 })
})
