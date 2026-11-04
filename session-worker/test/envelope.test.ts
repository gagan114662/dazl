// #436: a 200 JSON answer that is a platform's error envelope (login wall, rate limit, blocked request) or that lacks the
// platform's result container is a typed failure, never an empty search; a present-but-empty result container is a
// genuine search that found nothing. Stubbed fetch and a booted worker with a stubbed platform; no live platform calls.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { FetchFailure } from '../src/util.ts'
import { FETCHERS, checkBilibili, checkInstagram, checkLinkedin, checkReddit, checkX, type Platform } from '../src/fetchers.ts'

const realFetch = globalThis.fetch
const stub = (body: string, status = 200) => { globalThis.fetch = (async () => new Response(body, { status })) as typeof fetch }
test.afterEach(() => { globalThis.fetch = realFetch })
const outcome = async (p: Promise<unknown>) => { try { const v = await p; return Array.isArray(v) ? `items:${v.length}` : 'resolved' } catch (e) { return e instanceof FetchFailure ? e.kind : `other:${String(e)}` } }
const SESSION: Record<string, string> = { reddit: 'reddit_session=1', bilibili: 'SESSDATA=1', instagram: 'sessionid=1', x: `auth_token=${'a'.repeat(40)}; ct0=${'b'.repeat(32)}`, linkedin: 'li_at=1; JSESSIONID="ajax:1"' }
const run = (p: Platform, body: unknown) => { stub(typeof body === 'string' ? body : JSON.stringify(body)); return outcome(FETCHERS[p]('hiring sales', SESSION[p], {})) }

const quote = 'We are hiring a sales operations manager to clean up our CRM pipeline this quarter.'
const CASES: Record<string, [unknown, string][]> = {
  reddit: [
    [{ kind: 'Listing', data: { children: [] } }, 'items:0'],
    [{ kind: 'Listing', data: { children: [{ data: { permalink: '/r/sales/comments/1/x/', title: 'Hiring', selftext: quote, created_utc: 1761955200 } }] } }, 'items:1'],
    [{ error: 403, message: 'Forbidden' }, 'auth_failed'], [{ error: 401 }, 'auth_failed'], [{ error: 429, message: 'Too Many Requests' }, 'throttled'],
    [{ error: 500 }, 'upstream_error'], [{ error: 'weird' }, 'upstream_error'], [{ data: {} }, 'schema_error'], [{ data: { children: 'nope' } }, 'schema_error'],
  ],
  x: [
    [{ data: { search_by_raw_query: { search_timeline: { timeline: { instructions: [] } } } } }, 'items:0'],
    [{ errors: [{ code: 32, message: 'Could not authenticate you.' }] }, 'auth_failed'], [{ errors: [{ code: 89 }] }, 'auth_failed'], [{ errors: [{ code: 326 }] }, 'auth_failed'],
    [{ errors: [{ code: 88, message: 'Rate limit exceeded' }] }, 'throttled'], [{ errors: [{ code: 131 }] }, 'upstream_error'], [{ errors: [null, 'x', {}] }, 'upstream_error'],
    // Partial errors beside real data are not a refusal: the data is read.
    [{ errors: [{ code: 214 }], data: { search_by_raw_query: {} } }, 'items:0'],
    [{ data: {} }, 'schema_error'], [{ data: null }, 'schema_error'], [{ errors: [] }, 'schema_error'],
  ],
  bilibili: [
    [{ code: 0, data: { result: [] } }, 'items:0'], [{ code: 0, data: { numResults: 0 } }, 'items:0'],
    [{ code: 0, data: { result: [{ bvid: 'BV1xx', title: 'Sales ops', description: quote, pubdate: 1761955200 }] } }, 'items:1'],
    [{ code: -101, message: '账号未登录' }, 'auth_failed'], [{ code: -111 }, 'auth_failed'],
    [{ code: -412, message: '请求被拦截' }, 'throttled'], [{ code: -352 }, 'throttled'], [{ code: -509 }, 'throttled'], [{ code: -799 }, 'throttled'],
    [{ code: -400 }, 'upstream_error'], [{ code: '0', data: { result: [] } }, 'schema_error'], [{ code: 0.5 }, 'schema_error'], [{ data: { result: [] } }, 'schema_error'],
    [{ code: 0 }, 'schema_error'], [{ code: 0, data: { numResults: 3 } }, 'schema_error'], [{ code: 0, data: { result: 'x' } }, 'schema_error'],
  ],
  instagram: [
    [{ users: [], status: 'ok' }, 'items:0'],
    [{ users: [{ user: { username: 'acme', full_name: 'Acme', biography: quote } }], status: 'ok' }, 'items:1'],
    [{ status: 'fail', message: 'login_required' }, 'auth_failed'], [{ status: 'fail', require_login: true, message: '' }, 'auth_failed'],
    [{ status: 'fail', message: 'checkpoint_required' }, 'auth_failed'], [{ status: 'fail', message: 'Please wait a few minutes before you try again.' }, 'throttled'],
    [{ status: 'fail', spam: true }, 'throttled'], [{ status: 'fail', message: 42 }, 'upstream_error'], [{ status: 'ok' }, 'schema_error'], [{ users: {} }, 'schema_error'],
  ],
  linkedin: [
    [{ data: {}, included: [] }, 'items:0'], [{ elements: [] }, 'items:0'],
    [{ status: 401 }, 'auth_failed'], [{ status: 403, message: 'CSRF check failed' }, 'auth_failed'], [{ status: 429 }, 'throttled'], [{ status: 999 }, 'upstream_error'],
    [{ status: '401' }, 'schema_error'], [{ message: 'nothing here' }, 'schema_error'],
  ],
}

test('every supported fetcher: a genuine (empty or non-empty) result parses; error envelopes are their failure; a missing result container is schema_error', async () => {
  for (const [p, cases] of Object.entries(CASES)) for (const [body, want] of cases) assert.equal(await run(p as Platform, body), want, `${p} ${JSON.stringify(body)}`)
})

test('malformed answers of every type, size and depth fail closed as schema_error on every supported platform, never [] and never a crash', async () => {
  const N = 50_000
  const deep = '{"nested":'.repeat(N) + '{"data":{}}' + '}'.repeat(N)   // ~550 KB, 50k levels: under the 1 MB cap
  const bad = ['null', '[]', '"login"', '42', 'true', 'false', '{}', '[{"data":{"children":[]}}]', deep, JSON.stringify({ x: 'y'.repeat(500_000) })]
  for (const p of Object.keys(CASES) as Platform[]) for (const body of bad) assert.equal(await run(p, body), 'schema_error', `${p} ${body.slice(0, 40)}`)
  // Hostile nesting INSIDE a valid result container: the recursive walkers (X, LinkedIn) fail closed as schema_error,
  // never a crash that escapes the fetcher.
  const inner = (open: string, close: string) => open + '{"n":'.repeat(N) + '1' + '}'.repeat(N) + close
  assert.equal(await run('x', inner('{"data":{"search_by_raw_query":', '}}')), 'schema_error')
  assert.equal(await run('linkedin', inner('{"included":[', ']}')), 'schema_error')
  // Non-UTF8 bytes and a body over the cap still fail closed (getJson: schema_error).
  for (const p of Object.keys(CASES) as Platform[]) {
    globalThis.fetch = (async () => new Response(new Uint8Array([0xff, 0xfe, 0x7b, 0x80]), { status: 200 })) as typeof fetch
    assert.equal(await outcome(FETCHERS[p]('q', SESSION[p], {})), 'schema_error', `${p} non-utf8`)
  }
})

test('the checks read only the envelope: extra keys and unknown item shapes never fail a real result', () => {
  assert.doesNotThrow(() => checkReddit({ kind: 'Listing', data: { children: [{ weird: true }], after: null }, extra: 1 }))
  assert.doesNotThrow(() => checkX({ data: { search_by_raw_query: null }, extensions: {} }))
  assert.doesNotThrow(() => checkBilibili({ code: 0, message: '0', ttl: 1, data: { result: [{}] } }))
  assert.doesNotThrow(() => checkInstagram({ users: [{}], places: [], hashtags: [], status: 'ok' }))
  assert.doesNotThrow(() => checkLinkedin({ data: { '*elements': [] }, included: [{}], meta: {} }))
  // An error envelope is a FetchFailure with its kind (what the server turns into its 502 outcome), never a plain Error.
  try { checkBilibili({ code: -101 }); assert.fail('should throw') } catch (e) { assert.ok(e instanceof FetchFailure); assert.equal((e as FetchFailure).kind, 'auth_failed') }
})

// The booted worker over HTTP with a stubbed platform (test/platform-stub.ts): a 200 login-wall answer is a 502 with its
// outcome, a genuine empty result is a 200 with no items.
async function boot(body: string): Promise<{ base: string; child: ChildProcess }> {
  const port = 4800 + Math.floor(Math.random() * 400)
  const child = spawn(process.execPath, ['--experimental-strip-types', '--import', './test/platform-stub.ts', 'src/server.ts'], {
    env: { PATH: process.env.PATH, ADVANCED_WORKER_TOKEN: 'tok-436', PORT: String(port), PLATFORM_STUB_BODY: body }, stdio: 'ignore',
  })
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 100; i++) {
    try { if ((await realFetch(`${base}/health`)).ok) return { base, child } } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100))
  }
  child.kill(); throw new Error('worker did not start')
}
const post = (base: string, platform: string) => realFetch(`${base}/fetch`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer tok-436' }, body: JSON.stringify({ platform, query: 'hiring sales', session: SESSION[platform] }) })

test('over HTTP: a 200 login-wall answer from the platform is a 502 with its outcome, never an empty 200; a genuine empty search is 200 []', async () => {
  for (const [body, platform, status, want] of [
    [JSON.stringify({ code: -101, message: 'not logged in' }), 'bilibili', 502, { error: 'fetch_failed', outcome: 'auth_failed' }],
    [JSON.stringify({ status: 'fail', message: 'Please wait a few minutes before you try again.' }), 'instagram', 502, { error: 'fetch_failed', outcome: 'throttled' }],
    [JSON.stringify({ message: 'login page' }), 'reddit', 502, { error: 'fetch_failed', outcome: 'schema_error' }],
    [JSON.stringify({ kind: 'Listing', data: { children: [] } }), 'reddit', 200, { items: [] }],
  ] as const) {
    const { base, child } = await boot(body)
    try {
      const r = await post(base, platform)
      assert.equal(r.status, status, `${platform} ${body}`)
      const j = await r.json() as Record<string, unknown>
      assert.deepEqual(status === 200 ? { items: j.items } : j, want)
    } finally { child.kill() }
  }
})
