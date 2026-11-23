// Funnel analytics (#1616, lib/analytics): what may leave is an allowlist, the sender is off without a key, and it can
// never throw into or hold up its caller. Nothing leaves the process: every fetch here is a stub.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { CLIENT_EVENTS, DEFAULT_HOST, FUNNEL_EVENTS, PROPS, TIMEOUT_MS, funnelProps, track, type FunnelProps } from '../lib/analytics/track.ts'
import { searchFinished, searchStarted } from '../lib/analytics/funnel.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { resetTrackClient, trackClient } from '../lib/analytics/track-client.ts'
import { API_HOSTS } from '../lib/legal/policy.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const KEY = 'phc_dummy_not_a_real_project_token'
const ACCOUNT = 'a'.repeat(32)
type Call = { url: string; init: RequestInit }
const stub = (answer: () => Promise<Response> = async () => new Response('{"status":"Ok"}')) => {
  const calls: Call[] = []
  const f = ((url: string, init: RequestInit) => { calls.push({ url: String(url), init }); return answer() }) as unknown as typeof fetch
  return { calls, fetch: f }
}
const sent = (c: Call) => JSON.parse(String(c.init.body)) as { api_key: string; event: string; distinct_id: string; properties: Record<string, unknown>; timestamp: string }

test('the eight funnel events, named exactly', () => {
  assert.deepEqual([...FUNNEL_EVENTS], ['signup', 'google_linked', 'gmail_linked', 'first_search_started', 'first_search_finished', 'leads_shown', 'approve_clicked', 'email_sent'])
  for (const e of CLIENT_EVENTS) assert.ok((FUNNEL_EVENTS as readonly string[]).includes(e))
})

test('with no key nothing is sent, silently', () => {
  for (const env of [{}, { NEXT_PUBLIC_POSTHOG_KEY: '' }, { NEXT_PUBLIC_POSTHOG_HOST: 'https://eu.i.posthog.com' }]) {
    const s = stub()
    assert.equal(track('signup', ACCOUNT, { method: 'password' }, { env, fetch: s.fetch }), false)
    assert.equal(s.calls.length, 0)
  }
})

test('the request is PostHog\'s capture call: key, event, internal id, allowed properties, no person profile, no GeoIP', () => {
  const s = stub()
  assert.equal(track('leads_shown', ACCOUNT, { count: 7, job_id: 'b'.repeat(24) }, { env: { NEXT_PUBLIC_POSTHOG_KEY: KEY }, fetch: s.fetch, now: () => new Date('2026-11-23T12:00:00Z') }), true)
  assert.equal(s.calls.length, 1)
  assert.equal(s.calls[0].url, `${DEFAULT_HOST}/i/v0/e/`)
  assert.equal(s.calls[0].init.method, 'POST')
  assert.ok(s.calls[0].init.signal instanceof AbortSignal, `bounded by a ${TIMEOUT_MS} ms timeout`)
  assert.deepEqual(sent(s.calls[0]), { api_key: KEY, event: 'leads_shown', distinct_id: ACCOUNT, properties: { count: 7, job_id: 'b'.repeat(24), $process_person_profile: false, $geoip_disable: true }, timestamp: '2026-11-23T12:00:00.000Z' })
  // the default host is the one the privacy policy's host list discloses
  assert.equal(API_HOSTS[new URL(DEFAULT_HOST).host]?.name, 'PostHog')
})

test('the host comes from NEXT_PUBLIC_POSTHOG_HOST when it is an https URL, else the default', () => {
  const url = (host: string) => { const s = stub(); track('signup', ACCOUNT, {}, { env: { NEXT_PUBLIC_POSTHOG_KEY: KEY, NEXT_PUBLIC_POSTHOG_HOST: host }, fetch: s.fetch }); return s.calls[0].url }
  assert.equal(url('https://eu.i.posthog.com'), 'https://eu.i.posthog.com/i/v0/e/')
  assert.equal(url('https://eu.i.posthog.com/some/path/'), 'https://eu.i.posthog.com/i/v0/e/')
  assert.equal(url('http://insecure.test'), `${DEFAULT_HOST}/i/v0/e/`)
  assert.equal(url('not a url'), `${DEFAULT_HOST}/i/v0/e/`)
})

// The hard rule: a property outside the allowlist fails, and the event that carried it is never sent.
const FORBIDDEN: Record<string, unknown>[] = [
  { email: 'jane@example.com' }, { lead_email: 'jane@example.com' }, { name: 'Priya Venkataraman' }, { lead_name: 'Priya Venkataraman' },
  { company: 'Acme Roofing' }, { query: 'roofers in Austin hiring estimators' }, { search: 'roofers' }, { to: 'jane@example.com' }, { subject: 'Hello' },
  { $set: { email: 'jane@example.com' } }, { $ip: '203.0.113.9' }, { distinct_id: 'jane@example.com' }, { __proto__: null, constructor: 1 },
]
const BAD_VALUES: Record<string, unknown>[] = [
  { count: '7 leads for Acme' }, { count: -1 }, { count: 1.5 }, { count: Number.NaN }, { needs_review: 'two' }, { trial: 'yes' },
  { method: 'jane@example.com' }, { plan: 'Acme Roofing' }, { job_id: 'jane@example.com' }, { job_id: 'roofers in Austin' }, { message_id: 'Priya Venkataraman' }, { job_id: { nested: 'x' } },
]
test('a property outside the allowlist, or a value of the wrong shape, is refused and nothing is sent', () => {
  for (const props of [...FORBIDDEN, ...BAD_VALUES]) {
    assert.throws(() => funnelProps(props), TypeError, JSON.stringify(props))
    const s = stub()
    assert.equal(track('leads_shown', ACCOUNT, { count: 1, ...props } as FunnelProps, { env: { NEXT_PUBLIC_POSTHOG_KEY: KEY }, fetch: s.fetch }), false, JSON.stringify(props))
    assert.equal(s.calls.length, 0, `sent with ${JSON.stringify(props)}`)
  }
  for (const bad of ['a string', 7, ['count'], true]) assert.throws(() => funnelProps(bad), TypeError)
  assert.deepEqual(funnelProps(undefined), {})
  assert.deepEqual(funnelProps({ count: 0, needs_review: 2, method: 'google', plan: 'pro', trial: true, job_id: 'c'.repeat(24), message_id: 'd'.repeat(24), ignored: undefined }), { count: 0, needs_review: 2, method: 'google', plan: 'pro', trial: true, job_id: 'c'.repeat(24), message_id: 'd'.repeat(24) })
  // the list itself: a new property is a decision made here, with its reason
  assert.deepEqual(Object.keys(PROPS).sort(), ['count', 'job_id', 'message_id', 'method', 'needs_review', 'plan', 'trial'])
})

test('distinct_id is an internal id: an email address or a name is never sent as one', () => {
  for (const idv of ['jane@example.com', 'Priya Venkataraman', '', 'short', 'x'.repeat(65)]) {
    const s = stub()
    assert.equal(track('signup', idv, {}, { env: { NEXT_PUBLIC_POSTHOG_KEY: KEY }, fetch: s.fetch }), false)
    assert.equal(s.calls.length, 0)
  }
})

test('never throws into or waits for the caller: a throwing, rejecting or hanging request changes nothing', async () => {
  const env = { NEXT_PUBLIC_POSTHOG_KEY: KEY }
  const unhandled: unknown[] = []
  const onUnhandled = (e: unknown) => unhandled.push(e)
  process.on('unhandledRejection', onUnhandled)
  try {
    assert.equal(track('signup', ACCOUNT, {}, { env, fetch: (() => { throw new Error('boom') }) as unknown as typeof fetch }), false)
    assert.equal(track('signup', ACCOUNT, {}, { env, fetch: stub(() => Promise.reject(new Error('network down'))).fetch }), true)
    assert.equal(track('signup', ACCOUNT, {}, { env, fetch: stub(async () => new Response('nope', { status: 500 })).fetch }), true)
    const t0 = Date.now()
    assert.equal(track('signup', ACCOUNT, {}, { env, fetch: stub(() => new Promise<Response>(() => {})).fetch }), true)
    assert.ok(Date.now() - t0 < 50, 'returned without waiting for the request')
    assert.equal(track('not_an_event' as never, ACCOUNT, {}, { env, fetch: stub().fetch }), false)
    await new Promise(r => setTimeout(r, 20))
    assert.deepEqual(unhandled, [])
  } finally { process.off('unhandledRejection', onUnhandled) }
})

test('first search started / finished fire once per account, for a search and never for an import', async () => {
  const raw = new Database(':memory:'), db = sqliteDb(raw)
  raw.exec("CREATE TABLE scan_jobs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', csv_domain TEXT)")
  const env = { NEXT_PUBLIC_POSTHOG_KEY: KEY }
  const other = 'e'.repeat(32), j1 = '1'.repeat(24), j2 = '2'.repeat(24), csv = '3'.repeat(24)
  const s = stub(), d = { env, fetch: s.fetch }
  raw.prepare('INSERT INTO scan_jobs (id, user_id, csv_domain) VALUES (?, ?, ?)').run(csv, ACCOUNT, 'acme.example')
  assert.equal(await searchStarted(db, ACCOUNT, csv, false, d), false, 'an import is not a search')
  raw.prepare('INSERT INTO scan_jobs (id, user_id) VALUES (?, ?)').run(j1, ACCOUNT)
  raw.prepare('INSERT INTO scan_jobs (id, user_id) VALUES (?, ?)').run('9'.repeat(24), other)
  assert.equal(await searchStarted(db, ACCOUNT, j1, true, d), true)
  assert.deepEqual(sent(s.calls[0]).properties, { job_id: j1, trial: true, $process_person_profile: false, $geoip_disable: true })
  assert.equal(sent(s.calls[0]).event, 'first_search_started')
  assert.equal(await searchFinished(db, ACCOUNT, j1, 4, 2, d), false, 'not finished yet')
  raw.prepare("UPDATE scan_jobs SET status = 'done' WHERE id IN (?, ?)").run(j1, csv)
  assert.equal(await searchFinished(db, ACCOUNT, j1, 4, 2, d), true)
  assert.equal(sent(s.calls[1]).event, 'first_search_finished')
  assert.deepEqual(sent(s.calls[1]).properties, { job_id: j1, count: 4, needs_review: 2, $process_person_profile: false, $geoip_disable: true })
  raw.prepare("INSERT INTO scan_jobs (id, user_id, status) VALUES (?, ?, 'done')").run(j2, ACCOUNT)
  assert.equal(await searchStarted(db, ACCOUNT, j2, false, d), false, 'the second search is not the first')
  assert.equal(await searchFinished(db, ACCOUNT, j2, 1, 0, d), false)
  assert.equal(s.calls.length, 2)
  // a store that cannot be read is not the caller's problem
  raw.close()
  assert.equal(await searchStarted(db, ACCOUNT, j1, false, d), false)
  assert.equal(await searchFinished(db, ACCOUNT, j1, 0, 0, d), false)
  assert.equal(await searchStarted(Promise.reject(new Error('no store')), ACCOUNT, j1, false, d), false, 'a store that cannot be opened resolves false')
})

test('the browser helper posts to this app only, each distinct event once per page, and never throws', () => {
  resetTrackClient()
  const off = stub()
  assert.equal(trackClient('leads_shown', { count: 3 }, { fetch: off.fetch }, undefined), false, 'no key at build: no request at all')
  assert.equal(trackClient('leads_shown', { count: 3 }, { fetch: off.fetch }, ''), false)
  assert.equal(off.calls.length, 0)
  const s = stub()
  assert.equal(trackClient('leads_shown', { count: 3 }, { fetch: s.fetch }, KEY), true)
  assert.equal(trackClient('leads_shown', { count: 3 }, { fetch: s.fetch }, KEY), false, 'the same event again')
  assert.equal(trackClient('leads_shown', { count: 4 }, { fetch: s.fetch }, KEY), true)
  assert.deepEqual(s.calls.map(c => c.url), ['/api/track', '/api/track'])
  assert.deepEqual(JSON.parse(String(s.calls[0].init.body)), { event: 'leads_shown', props: { count: 3 } })
  assert.equal(trackClient('leads_shown', { count: 5 }, { fetch: (() => { throw new Error('boom') }) as unknown as typeof fetch }, KEY), false)
  assert.equal(trackClient('leads_shown', { count: 6 }, { fetch: stub(() => Promise.reject(new Error('offline'))).fetch }, KEY), true)
  assert.equal(trackClient('leads_shown', { count: 8 }, undefined, KEY), false, 'no window (server render)')
  resetTrackClient()
})

// Every call site in lib/ and app/: each of the eight events is fired somewhere, and no call passes a property key
// outside the allowlist (the type forbids it too; this also catches a cast).
test('every event has a call site, and every call site passes only allowlisted property names', () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap(n => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(n) ? [p] : []
  })
  const fired = new Set<string>()
  const bad: string[] = []
  for (const p of [...files(join(ROOT, 'lib')), ...files(join(ROOT, 'app'))]) {
    const rel = relative(ROOT, p)
    const text = readFileSync(p, 'utf8')
    if (rel === 'app/api/track/route.ts') { assert.match(text, /CLIENT_EVENTS\.includes\(body\?\.event\)/); assert.match(text, /funnelProps\(body\.props\)/); assert.match(text, /track\(body\.event as ClientEvent, user\.tenantId, props\)/); continue }
    for (const m of text.matchAll(/\b(?:track|trackClient)\('([a-z_]+)'([^\n]*)/g)) {
      if (!(FUNNEL_EVENTS as readonly string[]).includes(m[1])) { bad.push(`${rel}: unknown event ${m[1]}`); continue }
      fired.add(m[1])
      const obj = /\{([^{}]*)\}/.exec(m[2].split(')')[0] + ')')?.[1] ?? ''
      for (const k of obj.split(',').map(x => x.trim().split(':')[0].trim()).filter(Boolean)) if (!Object.hasOwn(PROPS, k)) bad.push(`${rel}: ${m[1]} passes ${k}`)
    }
  }
  assert.deepEqual(bad, [])
  assert.deepEqual([...fired].sort(), [...FUNNEL_EVENTS].sort())
})
