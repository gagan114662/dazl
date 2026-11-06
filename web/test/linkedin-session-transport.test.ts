// #192 owner-authorised scope (2026-11-06): the signed-in session transport and the reader's session plan. Invented data, a fake worker; no network, no LinkedIn call.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { bothEngines } from './helpers/engines.ts'
import { collectLinkedInPeople, DAY_CONNECTOR, MAX_REQUESTS_PER_HOUR, sessionLimits, type LinkedInTransport, type TransportRequest, type TransportResult } from '../lib/signals/linkedin-people.ts'
import { linkedinSessionTransport, mapOutcome, parseReply, sessionTransportEnabled } from '../lib/signals/linkedin-session-transport.ts'
import { writeConsent } from '../lib/advanced/index.ts'
import { setCompetitors } from '../lib/signals/competitor-reddit.ts'
import { writeCredential } from '../lib/connectors/store.ts'
import { requestsInWindow } from '../lib/advanced/request-budget.ts'
import type { Db } from '../lib/db/client.ts'

const ICP = { who: ['HR manager'], where: ['Ohio'], industries: ['SaaS'] }
const ENV = { ADVANCED_CONNECTORS: '1', ADVANCED_LINKEDIN: '1', ADVANCED_LINKEDIN_PEOPLE: '1' }
const T_ENV = { LINKEDIN_SESSION_TRANSPORT: '1', LINKEDIN_SESSION_TENANTS: 'A', ADVANCED_WORKER_URL: 'http://worker', ADVANCED_WORKER_TOKEN: 'tok' }
const POST = 'https://www.linkedin.com/feed/update/urn:li:activity:7391234567890123456/'
const NOW = Math.floor(Date.now() / 1000)
const MASTER = randomBytes(32)
const person = (id: string) => ({ url: `https://www.linkedin.com/in/${id}`, title: id, quote: `Commented on ${POST}: "${id} is evaluating alternatives"`, date: '2026-10-20' })
async function ready(db: Db, tenant = 'A') { await writeConsent(db, tenant, 'linkedin'); await setCompetitors(db, tenant, ['Rippling', 'Gusto']) }
const audits = async (db: Db) => (await db.all<{ connector: string; status: string; lookup: string }>("SELECT connector, status, lookup FROM connector_audit WHERE tenant_id = 'A' AND connector = 'adv:linkedin' ORDER BY insert_seq")).map(a => `${a.lookup.split(':')[0]}:${a.status}`)
function sessionFake(answer: (r: TransportRequest) => TransportResult) { const seen: TransportRequest[] = []; const t: LinkedInTransport = { session: true, fetch: async r => { seen.push(r); return answer(r) } }; return { t, seen } }
const answers = (r: TransportRequest): TransportResult => r.kind === 'posts' ? { status: 'ok', items: [{ url: POST, title: 'post', quote: 'Rippling announces a new payroll product line', date: null }] } : { status: 'ok', items: [person(`${r.kind}-1`), person('both-2')] }

test('the session transport is OFF unless its flag, the tenant allowlist and the worker settings are all set', () => {
  assert.equal(sessionTransportEnabled('A', {}), false)
  assert.equal(sessionTransportEnabled('A', { ...T_ENV, LINKEDIN_SESSION_TRANSPORT: '0' }), false)
  assert.equal(sessionTransportEnabled('B', T_ENV), false, 'a tenant that is not allowlisted never uses the session')
  assert.equal(sessionTransportEnabled('A', { ...T_ENV, ADVANCED_WORKER_TOKEN: '' }), false)
  assert.equal(sessionTransportEnabled('A', T_ENV), true)
  assert.equal(sessionTransportEnabled('A', { ...T_ENV, LINKEDIN_SESSION_TENANTS: ' X, A ' }), true)
})

test('worker failures map to named stops; an unsupported, error or malformed reply is an error, never zero results', () => {
  assert.deepEqual(mapOutcome('challenge'), { status: 'challenge' }); assert.deepEqual(mapOutcome('auth_failed'), { status: 'unauthorized' })
  assert.deepEqual(mapOutcome('throttled'), { status: 'throttled' }); assert.deepEqual(mapOutcome('schema_error'), { status: 'error' })
  assert.deepEqual(parseReply({ items: [], outcome: 'unsupported' }, 25), { status: 'error' }); assert.deepEqual(parseReply({ error: 'x', items: [] }, 25), { status: 'error' })
  assert.deepEqual(parseReply({ items: [] }, 25), { status: 'ok', items: [], upstream_requests: 1 })
  assert.equal((parseReply({ items: [], upstream_requests: 2 }, 25) as { upstream_requests: number }).upstream_requests, 2, 'a worker that reports two upstream requests is passed through, so the reader stops on the contract')
})

bothEngines('transport: reads the stored session, one worker request per call, posts via /fetch, engagers via /linkedin/engagers; no session = no request', async ({ db }) => {
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
  assert.equal(calls[1].url, 'http://worker/fetch'); assert.deepEqual({ ...calls[1].body, session: '-' }, { platform: 'linkedin', query: 'Rippling', session: '-' })
  reply = { status: 502, body: { error: 'fetch_failed', outcome: 'challenge' } }
  assert.deepEqual(await t.fetch(req('reactors', POST)), { status: 'challenge' })
  assert.deepEqual(await t.fetch(req('people', 'HR manager')), { status: 'error' }, 'the session transport only reads posts and engagers'); assert.equal(calls.length, 3)
  assert.deepEqual(await t.fetch({ ...req('commenters', POST), tenantId: 'B' }), { status: 'unauthorized' }, 'a non-allowlisted tenant'); assert.equal(calls.length, 3)
})

bothEngines('session plan: competitor post search, then that post\'s commenters and reactors, paced, deduplicated profiles only', async ({ db }) => {
  await ready(db)
  const { t, seen } = sessionFake(answers); const slept: number[] = []
  const out = await collectLinkedInPeople(db, 'A', 'j', ICP, { transport: t, env: { ...ENV, LINKEDIN_SESSION_GAP_MS: '1000' }, now: NOW, sleep: async ms => { slept.push(ms) } })
  assert.deepEqual(seen.map(r => `${r.kind}:${r.query}`), ['posts:Rippling', `commenters:${POST}`, `reactors:${POST}`], 'one competitor fully read within the per-run cap of 3')
  assert.deepEqual(out.map(i => i.url), ['https://www.linkedin.com/in/commenters-1', 'https://www.linkedin.com/in/both-2', 'https://www.linkedin.com/in/reactors-1'])
  assert.ok(out.every(i => i.login_walled && i.quote.length > 0 && i.url.startsWith('https://www.linkedin.com/in/')), 'review lane, with a quote that carries the post link')
  assert.equal(slept.length, 2); assert.ok(slept.every(ms => ms >= 1000 && ms <= 1500), 'a human pace between session requests')
  assert.deepEqual(await audits(db), ['posts:ok', 'commenters:ok', 'reactors:ok'])
  assert.equal(await requestsInWindow(db, 'A', 'adv:linkedin', NOW), 3); assert.equal(await requestsInWindow(db, 'A', DAY_CONNECTOR, NOW), 3)
})

bothEngines('session stops: a checkpoint/captcha stops the run at once, is audited and reported, and cools the tenant down', async ({ db }) => {
  await ready(db)
  const { t, seen } = sessionFake(r => r.kind === 'posts' ? answers(r) : { status: 'challenge' })
  const stops: string[] = []
  assert.deepEqual(await collectLinkedInPeople(db, 'A', 'j', ICP, { transport: t, env: ENV, now: NOW, sleep: async () => {}, onStop: s => stops.push(s) }), [])
  assert.equal(seen.length, 2, 'no retry, no reactors call after the challenge'); assert.deepEqual(stops, ['stopped_challenge'])
  assert.deepEqual(await audits(db), ['posts:ok', 'commenters:stopped_challenge'])
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
