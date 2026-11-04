// #436: a 200 JSON answer that is a platform's error envelope (login wall, rate limit, blocked request) or that lacks the
// platform's result container is a typed failure, never an empty search; a present-but-empty result container is a
// genuine search that found nothing only when the platform says so explicitly. Stubbed fetch and a booted worker with a
// stubbed platform; no live platform calls.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { FetchFailure } from '../src/util.ts'
import { FETCHERS, checkBilibili, checkInstagram, checkLinkedin, checkReddit, checkX, type Platform } from '../src/fetchers.ts'

const realFetch = globalThis.fetch
const stub = (body: string, status = 200) => { globalThis.fetch = (async () => new Response(body, { status })) as typeof fetch }
test.afterEach(() => { globalThis.fetch = realFetch })
const outcome = async (p: Promise<unknown>) => { try { const v = await p; return Array.isArray(v) ? `items:${v.length}` : 'resolved' } catch (e) { return e instanceof FetchFailure ? e.kind : `other:${String(e)}` } }
const SESSION: Record<string, string> = { reddit: 'reddit_session=1', bilibili: 'SESSDATA=1', instagram: 'sessionid=1', x: `auth_token=${'a'.repeat(40)}; ct0=${'b'.repeat(32)}`, linkedin: 'li_at=1; JSESSIONID="ajax:1"' }
const run = (p: Platform, body: unknown) => { stub(typeof body === 'string' ? body : JSON.stringify(body)); return outcome(FETCHERS[p]('hiring sales', SESSION[p], {})) }

const quote = 'We are hiring a sales operations manager to clean up our CRM pipeline this quarter.'
// Genuine answers, shaped like each platform's real search response.
const listing = (children: unknown[]) => ({ kind: 'Listing', data: { children, after: null } })
const redditPost = { data: { permalink: '/r/sales/comments/1/x/', title: 'Hiring', selftext: quote, created_utc: 1761955200 } }
const tweet = { entryId: 'tweet-1', content: { itemContent: { tweet_results: { result: { legacy: { id_str: '1', full_text: quote, created_at: 'Sat Nov 01 00:00:00 +0000 2025' }, core: { user_results: { result: { legacy: { screen_name: 'acme' } } } } } } } } }
const xTimeline = (entries: unknown[]) => ({ search_by_raw_query: { search_timeline: { timeline: { instructions: entries.length ? [{ type: 'TimelineAddEntries', entries }] : [] } } } })
const biliVideo = { bvid: 'BV1xx', title: 'Sales ops', description: quote, pubdate: 1761955200 }
const igUser = { user: { username: 'acme', full_name: 'Acme', biography: quote } }
const liPost = { $type: 'com.linkedin.voyager.dash.search.EntityResultViewModel', trackingUrn: 'urn:li:activity:7390000000000000000', commentary: { text: { text: quote } } }
const liResult = { data: { metadata: {}, elements: [{ items: [{ '*item': 'urn:li:fsd_entityResultViewModel:1' }] }], paging: { count: 10, start: 0, total: 1 } }, included: [liPost] }
const liZero = { data: { metadata: {}, elements: [], paging: { count: 10, start: 0, total: 0 } }, included: [] }

const CASES: Record<string, [unknown, string][]> = {
  reddit: [
    [listing([]), 'items:0'], [listing([redditPost]), 'items:1'],
    [{ error: 403, message: 'Forbidden' }, 'auth_failed'], [{ error: 401 }, 'auth_failed'], [{ error: 429, message: 'Too Many Requests' }, 'throttled'],
    [{ error: 500 }, 'upstream_error'], [{ error: 'weird' }, 'upstream_error'], [{ data: {} }, 'schema_error'], [{ data: { children: 'nope' } }, 'schema_error'],
    // A refusal beside an (empty) listing is the refusal, whatever the type of the error field.
    [{ ...listing([]), error: 403 }, 'auth_failed'], [{ error: 429, data: { children: [] } }, 'throttled'], [{ ...listing([]), error: '401' }, 'auth_failed'],
    [{ ...listing([redditPost]), error: true }, 'upstream_error'], [{ ...listing([]), error: 200 }, 'upstream_error'], [{ ...listing([]), error: -1 }, 'upstream_error'],
    [{ ...listing([]), error: null }, 'items:0'],
    // An empty list that is not a Listing is not an explicit zero-result answer.
    [{ data: { children: [] } }, 'schema_error'], [{ kind: 't3', data: { children: [] } }, 'schema_error'], [{ kind: 'Listing', data: [] }, 'schema_error'], [{ kind: 'Listing', data: null }, 'schema_error'],
  ],
  x: [
    [{ data: xTimeline([]) }, 'items:0'], [{ data: xTimeline([tweet]) }, 'items:1'], [{ data: xTimeline([]), errors: null }, 'items:0'],
    [{ errors: [{ code: 32, message: 'Could not authenticate you.' }] }, 'auth_failed'], [{ errors: [{ code: 89 }] }, 'auth_failed'], [{ errors: [{ code: 326 }] }, 'auth_failed'],
    [{ errors: [{ code: 88, message: 'Rate limit exceeded' }] }, 'throttled'], [{ errors: [{ code: 131 }] }, 'upstream_error'], [{ errors: [null, 'x', {}] }, 'upstream_error'],
    [{ data: {} }, 'schema_error'], [{ data: null }, 'schema_error'], [{ errors: [] }, 'schema_error'],
    // An auth or rate-limit code beside an (empty or not) timeline is the refusal; a string code is read as its number.
    [{ errors: [{ code: 32 }], data: xTimeline([]) }, 'auth_failed'], [{ errors: [{ code: '215' }], data: xTimeline([tweet]) }, 'auth_failed'],
    [{ errors: [{ code: 88 }], data: xTimeline([tweet]) }, 'throttled'], [{ errors: [{ code: 131 }], data: { search_by_raw_query: {} } }, 'upstream_error'],
    // Partial errors beside real entries are read; beside no entries the answer is the error.
    [{ errors: [{ code: 214 }], data: xTimeline([tweet]) }, 'items:1'], [{ errors: [{ code: 214 }], data: xTimeline([]) }, 'upstream_error'],
    // A search container without a timeline is not a result.
    [{ data: { search_by_raw_query: null } }, 'schema_error'], [{ data: { search_by_raw_query: {} } }, 'schema_error'],
    [{ data: { search_by_raw_query: { search_timeline: { timeline: { instructions: 'x' } } } } }, 'schema_error'],
    [{ errors: { code: 32 }, data: xTimeline([]) }, 'schema_error'], [{ errors: 'denied', data: xTimeline([tweet]) }, 'schema_error'], [{ data: [] }, 'schema_error'],
  ],
  bilibili: [
    [{ code: 0, data: { result: [], numResults: 0 } }, 'items:0'], [{ code: 0, data: { numResults: 0 } }, 'items:0'],
    [{ code: 0, data: { result: [biliVideo], numResults: 1 } }, 'items:1'], [{ code: 0, data: { result: [biliVideo] } }, 'items:1'],
    [{ code: -101, message: '账号未登录' }, 'auth_failed'], [{ code: -111 }, 'auth_failed'],
    [{ code: -412, message: '请求被拦截' }, 'throttled'], [{ code: -352 }, 'throttled'], [{ code: -509 }, 'throttled'], [{ code: -799 }, 'throttled'],
    [{ code: -400 }, 'upstream_error'], [{ code: '0', data: { result: [] } }, 'schema_error'], [{ code: 0.5 }, 'schema_error'], [{ data: { result: [] } }, 'schema_error'],
    [{ code: 0 }, 'schema_error'], [{ code: 0, data: { numResults: 3 } }, 'schema_error'], [{ code: 0, data: { result: 'x' } }, 'schema_error'],
    // A refusal code beside a result container is the refusal.
    [{ code: -101, data: { result: [], numResults: 0 } }, 'auth_failed'], [{ code: -412, data: { result: [biliVideo] } }, 'throttled'],
    // Risk control on code 0: a v_voucher challenge instead of results is throttling, never an empty search.
    [{ code: 0, message: '0', data: { v_voucher: 'voucher_1' } }, 'throttled'], [{ code: 0, data: { v_voucher: 'voucher_1', result: [], numResults: 0 } }, 'throttled'],
    // An empty list without an explicit zero count is not a result; neither is a wrong-typed count or code.
    [{ code: 0, data: { result: [] } }, 'schema_error'], [{ code: 0, data: { result: [], numResults: 5 } }, 'schema_error'], [{ code: 0, data: { numResults: '0' } }, 'schema_error'],
    [{ code: null, data: { result: [biliVideo] } }, 'schema_error'], [{ code: true }, 'schema_error'], [{ code: 0, data: [] }, 'schema_error'], [{ code: 0, data: 'x' }, 'schema_error'],
  ],
  instagram: [
    [{ users: [], status: 'ok' }, 'items:0'], [{ users: [igUser], status: 'ok' }, 'items:1'],
    [{ status: 'fail', message: 'login_required' }, 'auth_failed'], [{ status: 'fail', require_login: true, message: '' }, 'auth_failed'],
    [{ status: 'fail', message: 'checkpoint_required' }, 'auth_failed'], [{ status: 'fail', message: 'Please wait a few minutes before you try again.' }, 'throttled'],
    [{ status: 'fail', spam: true }, 'throttled'], [{ status: 'fail', message: 42 }, 'upstream_error'], [{ status: 'ok' }, 'schema_error'], [{ users: {} }, 'schema_error'],
    // A refusal marker beside a users list (with or without a status) is the refusal.
    [{ users: [], status: 'fail', message: 'login_required' }, 'auth_failed'], [{ users: [], require_login: true }, 'auth_failed'],
    [{ users: [], status: 'ok', spam: true }, 'throttled'], [{ users: [igUser], message: 'Please wait a few minutes before you try again.' }, 'throttled'],
    [{ users: [], status: 'fail', message: 'something else' }, 'upstream_error'],
    // A users list without an explicit status 'ok' is not a result.
    [{ users: [] }, 'schema_error'], [{ users: [], status: 'FAIL' }, 'schema_error'], [{ users: [], status: 200 }, 'schema_error'], [{ users: [], status: null }, 'schema_error'],
  ],
  linkedin: [
    [liResult, 'items:1'], [liZero, 'items:0'], [{ elements: [], paging: { count: 10, start: 0, total: 0 } }, 'items:0'],
    [{ status: 401 }, 'auth_failed'], [{ status: 403, message: 'CSRF check failed' }, 'auth_failed'], [{ status: 429 }, 'throttled'], [{ status: 999 }, 'upstream_error'],
    [{ status: '401' }, 'schema_error'], [{ message: 'nothing here' }, 'schema_error'],
    // Instinct's reproduced blocker on 5a6bffa8: a numeric refusal status wins over an empty or message-only container.
    [{ status: 401, data: {} }, 'auth_failed'], [{ status: 429, data: { message: 'rate' } }, 'throttled'], [{ status: 999, included: [] }, 'upstream_error'],
    // ...and over a real-looking one.
    [{ status: 401, ...liResult }, 'auth_failed'], [{ status: 403, elements: [{}] }, 'auth_failed'], [{ status: 500, ...liZero }, 'upstream_error'],
    // An empty container with no refusal status is not a result: schema_error, unless it is an explicit zero-result answer.
    [{ data: {} }, 'schema_error'], [{ data: {}, included: [] }, 'schema_error'], [{ elements: [] }, 'schema_error'], [{ included: [] }, 'schema_error'],
    [{ data: { message: 'rate' } }, 'schema_error'], [{ data: { elements: [], paging: { total: 3 } }, included: [] }, 'schema_error'],
    [{ data: { elements: [], paging: { total: '0' } } }, 'schema_error'], [{ ...liZero, included: 'x' }, 'schema_error'], [{ elements: 'x', paging: { total: 0 } }, 'schema_error'],
    // Status of the wrong type, out of range, or a 2xx beside an error marker.
    [{ status: '401', data: {} }, 'schema_error'], [{ status: true, ...liResult }, 'schema_error'], [{ status: null, ...liResult }, 'schema_error'],
    [{ status: 401.5, ...liResult }, 'schema_error'], [{ status: {}, ...liResult }, 'schema_error'], [{ status: -1, ...liResult }, 'upstream_error'], [{ status: 1e300, ...liResult }, 'upstream_error'],
    [{ status: 200, ...liResult }, 'items:1'], [{ status: 204, ...liZero }, 'items:0'], [{ status: 200, data: {} }, 'schema_error'],
    [{ status: 200, serviceErrorCode: 65600, ...liZero }, 'upstream_error'], [{ serviceErrorCode: 0, data: {} }, 'upstream_error'], [{ exceptionClass: 'com.linkedin.x', ...liResult }, 'upstream_error'],
    // data of the wrong type is unreadable, even beside content.
    [{ data: [], included: [liPost] }, 'schema_error'], [{ data: 'x', included: [liPost] }, 'schema_error'], [{ data: null, included: [liPost] }, 'schema_error'],
    // A huge result container is still read (and finds nothing to keep).
    [{ data: { elements: [{}] }, included: Array.from({ length: 100_000 }, () => ({})) }, 'items:0'],
  ],
}

test('every supported fetcher: a genuine (empty or non-empty) result parses; error envelopes are their failure, even beside a result container; a missing or unexplained empty container is schema_error', async () => {
  for (const [p, cases] of Object.entries(CASES)) for (const [body, want] of cases) assert.equal(await run(p as Platform, body), want, `${p} ${JSON.stringify(body).slice(0, 200)}`)
})

test('malformed answers of every type, size and depth fail closed as schema_error on every supported platform, never [] and never a crash', async () => {
  const N = 50_000
  const deep = '{"nested":'.repeat(N) + '{"data":{}}' + '}'.repeat(N)   // ~550 KB, 50k levels: under the 1 MB cap
  const bad = ['null', '[]', '"login"', '42', 'true', 'false', '{}', '[{"data":{"children":[]}}]', deep, JSON.stringify({ x: 'y'.repeat(500_000) })]
  for (const p of Object.keys(CASES) as Platform[]) for (const body of bad) assert.equal(await run(p, body), 'schema_error', `${p} ${body.slice(0, 40)}`)
  // Hostile nesting INSIDE a valid result container: the recursive walkers (X, LinkedIn) fail closed as schema_error,
  // never a crash that escapes the fetcher.
  const inner = (open: string, close: string) => open + '{"n":'.repeat(N) + '1' + '}'.repeat(N) + close
  assert.equal(await run('x', inner('{"data":{"search_by_raw_query":{"search_timeline":{"timeline":{"instructions":[', ']}}}}}')), 'schema_error')
  assert.equal(await run('linkedin', inner('{"included":[', ']}')), 'schema_error')
  // Non-UTF8 bytes and a body over the cap still fail closed (getJson: schema_error).
  for (const p of Object.keys(CASES) as Platform[]) {
    globalThis.fetch = (async () => new Response(new Uint8Array([0xff, 0xfe, 0x7b, 0x80]), { status: 200 })) as typeof fetch
    assert.equal(await outcome(FETCHERS[p]('q', SESSION[p], {})), 'schema_error', `${p} non-utf8`)
  }
})

test('the checks read only the envelope: extra keys and unknown item shapes never fail a real result', () => {
  assert.doesNotThrow(() => checkReddit({ kind: 'Listing', data: { children: [{ weird: true }], after: null }, extra: 1 }))
  assert.doesNotThrow(() => checkX({ data: xTimeline([{ weird: true }]), extensions: {} }))
  assert.doesNotThrow(() => checkBilibili({ code: 0, message: '0', ttl: 1, data: { result: [{}] } }))
  assert.doesNotThrow(() => checkInstagram({ users: [{}], places: [], hashtags: [], status: 'ok' }))
  assert.doesNotThrow(() => checkLinkedin({ data: { '*elements': [] }, included: [{}], meta: {} }))
  assert.doesNotThrow(() => checkLinkedin({ data: { '*elements': ['urn:li:x'] } }))
  // An error envelope is a FetchFailure with its kind (what the server turns into its 502 outcome), never a plain Error.
  try { checkBilibili({ code: -101 }); assert.fail('should throw') } catch (e) { assert.ok(e instanceof FetchFailure); assert.equal((e as FetchFailure).kind, 'auth_failed') }
})

test('the checks throw nothing but a FetchFailure, for any JSON value in any envelope field', () => {
  const odd: unknown[] = [null, true, false, 0, -1, 1.5, 1e300, '', '401', 'fail', [], [null], {}, { code: {} }, [[[]]], Object.create(null)]
  const keys = ['status', 'code', 'error', 'errors', 'data', 'included', 'elements', 'users', 'message', 'kind', 'require_login', 'spam', 'serviceErrorCode', 'paging']
  const checks = [checkReddit, checkX, checkBilibili, checkInstagram, checkLinkedin]
  for (const check of checks) for (const k of keys) for (const v of odd) for (const base of [{}, listing([]), { data: xTimeline([]) }, { code: 0, data: { result: [], numResults: 0 } }, { users: [], status: 'ok' }, liZero]) {
    try { check({ ...base, [k]: v }) } catch (e) { assert.ok(e instanceof FetchFailure, `${check.name} ${k}=${JSON.stringify(v)}: ${String(e)}`) }
  }
})

// The booted worker over HTTP with a stubbed platform (test/platform-stub.ts): a 200 login-wall answer is a 502 with its
// outcome, a genuine empty result is a 200 with no items.
// A free port from the OS (never a random guess that can collide with another suite's worker), a 30 s start budget, and one
// retry on a fresh port if the child exits early (CI runners can be slow or racy on a port just released).
const freePort = () => new Promise<number>((resolve, reject) => { const srv = createServer(); srv.once('error', reject); srv.listen(0, '127.0.0.1', () => { const a = srv.address(); srv.close(() => resolve(typeof a === 'object' && a ? a.port : 0)) }) })
async function boot(body: string, attempt = 1): Promise<{ base: string; child: ChildProcess }> {
  const port = await freePort()
  const child = spawn(process.execPath, ['--experimental-strip-types', '--import', './test/platform-stub.ts', 'src/server.ts'], {
    env: { PATH: process.env.PATH, ADVANCED_WORKER_TOKEN: 'tok-436', PORT: String(port), PLATFORM_STUB_BODY: body }, stdio: 'ignore',
  })
  let exited = false
  child.once('exit', () => { exited = true })
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 300 && !exited; i++) {
    try { if ((await realFetch(`${base}/health`)).ok) return { base, child } } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100))
  }
  child.kill()
  if (attempt < 2) return boot(body, attempt + 1)
  throw new Error(`worker did not start (port ${port}, exited ${exited})`)
}
const post = (base: string, platform: string) => realFetch(`${base}/fetch`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer tok-436' }, body: JSON.stringify({ platform, query: 'hiring sales', session: SESSION[platform] }) })

test('over HTTP: a 200 login-wall answer from the platform is a 502 with its outcome, never an empty 200; a genuine empty search is 200 []', async () => {
  for (const [body, platform, status, want] of [
    [JSON.stringify({ code: -101, message: 'not logged in' }), 'bilibili', 502, { error: 'fetch_failed', outcome: 'auth_failed' }],
    [JSON.stringify({ status: 'fail', message: 'Please wait a few minutes before you try again.' }), 'instagram', 502, { error: 'fetch_failed', outcome: 'throttled' }],
    [JSON.stringify({ message: 'login page' }), 'reddit', 502, { error: 'fetch_failed', outcome: 'schema_error' }],
    [JSON.stringify({ status: 429, data: { message: 'rate' } }), 'linkedin', 502, { error: 'fetch_failed', outcome: 'throttled' }],
    [JSON.stringify({ kind: 'Listing', data: { children: [] } }), 'reddit', 200, { items: [] }],
  ] as const) {
    const { base, child } = await boot(body)
    try {
      const r = await post(base, platform)
      assert.equal(r.status, status, `${platform} ${body}`)
      const j = await r.json() as Record<string, unknown>
      assert.deepEqual(status === 200 ? { items: j.items } : j, want)
    } finally { child.kill(); await new Promise(r => child.exitCode !== null || child.signalCode !== null ? r(null) : child.once('exit', r)) }
  }
})
