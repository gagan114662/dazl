// Browser error monitoring: the browser reporter (lib/client-error-report.ts) with a fake window, the report guard
// (lib/ops/client-errors.ts) and the endpoint (app/api/client-errors, run in a child process through the real route
// file). What the browser sends and what the server keeps are allowlists: no error message or stack text, so a name or
// secret the scrubber would not recognise can never reach the payload or the record. Nothing leaves the process.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setErrorSinks, type ErrorRecord } from '../lib/ops/errors.ts'
import { recordClientError } from '../lib/ops/client-errors.ts'
import { MAX_BODY, clientFrames, clientReport, installClientErrorReporting, loadedScripts, reportClientError, resetClientErrorReporting } from '../lib/client-error-report.ts'

// The scripts a page loaded (browser side) and the bundles a build emitted (server side, a fake .next/static).
const LOADED = new Set(['/_next/static/chunks/app/page-1a2b.js', '/_next/static/chunks/main.js'])
const ROOT = mkdtempSync(path.join(tmpdir(), 'dazl-build-'))
for (const f of ['chunks/app/page-1a2b.js', 'chunks/main.js', 'chunks/a.js']) { mkdirSync(path.dirname(path.join(ROOT, '.next/static', f)), { recursive: true }); writeFileSync(path.join(ROOT, '.next/static', f), '') }
const capture = () => { const got: ErrorRecord[] = []; const restore = setErrorSinks([r => got.push(r)]); return { got, restore } }
// What a scrubber would not catch: a person's name, an opaque secret, a free-text note.
const NAME = 'Priya Venkataraman', SECRET = 'q7Rk2mZp9XwB4vNf8LtY3sHd6JcE1aUo', NOTE = 'owner said budget frees up after the merger'
const SENSITIVE = [NAME, 'Priya', 'Venkataraman', SECRET, NOTE, 'merger', 'jane@example.com']
const leaky = () => {
  const e = new TypeError(`Cannot draft for ${NAME} (jane@example.com) with ${SECRET}: ${NOTE}`)
  e.stack = `TypeError: Cannot draft for ${NAME}\n    at draftFor${NAME.replace(' ', '')} (https://dazl.ai/_next/static/chunks/app/page-1a2b.js?k=${SECRET}:12:345)\n    at ${SECRET} (https://evil.example/${NAME}.js:1:1)\n    at https://dazl.ai/_next/static/chunks/main.js:7:89`
  return e
}

test('the browser report is an allowlist: kind, built-in type, path, bundle frames; never the message or stack text', () => {
  const body = clientReport('boundary', leaky(), '/app/leads', LOADED)
  assert.deepEqual(JSON.parse(body), { kind: 'boundary', type: 'TypeError', path: '/app/leads', frames: [{ file: '/_next/static/chunks/app/page-1a2b.js', line: 12, col: 345 }, { file: '/_next/static/chunks/main.js', line: 7, col: 89 }] })
  for (const leak of SENSITIVE) assert.ok(!body.includes(leak), `${leak} in the browser payload`)
  // a non-built-in class name (which could be anything) becomes Error; a thrown string sends nothing of itself
  assert.equal(JSON.parse(clientReport('error', Object.assign(new Error('x'), { name: `${NAME.replace(' ', '')}Error` }), '/')).type, 'Error')
  assert.deepEqual(JSON.parse(clientReport('unhandledrejection', `${NAME} ${SECRET}`, '/sign-in')), { kind: 'unhandledrejection', type: 'Error', path: '/sign-in', frames: [] })
  // Firefox/Safari frame lines keep only file:line:col too
  assert.deepEqual(clientFrames(`load${NAME}@https://dazl.ai/_next/static/chunks/main.js:3:9\n@https://dazl.ai/_next/static/chunks/app/page-1a2b.js:1:2`, LOADED), [{ file: '/_next/static/chunks/main.js', line: 3, col: 9 }, { file: '/_next/static/chunks/app/page-1a2b.js', line: 1, col: 2 }])
})

test('the browser report never exceeds MAX_BODY bytes', () => {
  const e = new Error('x')
  e.stack = Array.from({ length: 50 }, (_, i) => `    at f (https://dazl.ai/_next/static/chunks/${'a'.repeat(180)}${i}.js:1:1)`).join('\n')
  const body = clientReport('error', e, '/app/' + 'x'.repeat(5000), new Set(Array.from({ length: 50 }, (_, i) => `/_next/static/chunks/${'a'.repeat(180)}${i}.js`)))
  assert.ok(body.length <= MAX_BODY, String(body.length))
  assert.ok(JSON.parse(body).frames.length < 8, 'frames dropped to fit')
})

test('the server keeps only allowlisted fields: no message, no stack text, no body tenant; bad shapes dropped', () => {
  const { got, restore } = capture()
  try {
    const r = recordClientError({
      kind: 'error', type: 'TypeError', path: '/app/campaigns/0123456789abcdef0123456789abcdef?email=jane@example.com',
      frames: [...Array.from({ length: 12 }, (_, i) => ({ file: '/_next/static/chunks/a.js', line: i, col: 1 })), { file: `/home/${NAME}.js`, line: 1, col: 1 }],
      // fields an old or hostile client might add: all ignored
      message: `${NAME} ${SECRET} ${NOTE}`, stack: `at ${NAME} (https://dazl.ai/_next/static/x.js:1:1)`, name: `${NAME}Error`, tenant: 'f'.repeat(32),
    }, { tenantId: 'a'.repeat(32), requestId: 'not-a-request-id', root: ROOT })
    assert.ok(r && r !== 'invalid')
    const g = got[0]
    assert.deepEqual([g.source, g.where, g.tenant, g.error.name, g.error.message], ['client', 'error:/app/campaigns/[id]', 'a'.repeat(32), 'TypeError', 'browser error'])
    assert.equal(g.error.stack.length, 8)
    assert.equal(g.error.stack[0], 'at <client> (/_next/static/chunks/a.js:0:1)')
    assert.equal('request_id' in g, false)
    const s = JSON.stringify(g)
    for (const leak of [...SENSITIVE, '0123456789abcdef0123456789abcdef', 'f'.repeat(32)]) assert.ok(!s.includes(leak), `${leak} reached the record`)
    recordClientError({ kind: 'boundary', type: 'PriyaError', path: '/sign-in', frames: [{ file: '/_next/static/chunks/a.js', line: -1, col: 1 }, { file: '/_next/static/chunks/a.js', line: 1.5, col: 1 }, 'x'] }, { root: ROOT })
    assert.deepEqual([got[1].where, got[1].error.name, got[1].error.stack], ['boundary:/sign-in', 'Error', []])
    recordClientError({ kind: 'boundary', path: '/jane@example.com/profile' }, {})
    assert.equal(got[2].where, 'boundary:/[unknown]')
    for (const bad of [null, 'x', [], { kind: 'other', path: '/app' }, { kind: 'error' }, { kind: 'error', path: 'https://evil.example/' }]) assert.equal(recordClientError(bad, {}), 'invalid')
    assert.equal(got.length, 3)
  } finally { restore() }
})

// Review repro (#312/#313): a path that fits the bundle pattern but is made of a name and a secret
test('review repro: a frame path made of a name and a secret is neither sent nor kept; a real bundle frame is', () => {
  const fake = 'https://dazl.ai/_next/static/AliceSmith/password-river-mint-secret.js'
  const e = new Error('x')
  e.stack = `Error: x\n    at f (${fake}:3:4)\n    at g (https://dazl.ai/_next/static/chunks/main.js:7:8)`
  // browser: only scripts the page loaded; the fake path was never loaded
  const body = clientReport('error', e, '/app', LOADED)
  assert.deepEqual(JSON.parse(body).frames, [{ file: '/_next/static/chunks/main.js', line: 7, col: 8 }])
  // even if the page had "loaded" it, or a client posts it directly, the server keeps only emitted bundles
  const posted = JSON.parse(clientReport('error', e, '/app', new Set([...LOADED, new URL(fake).pathname])))
  assert.equal(posted.frames.length, 2)
  const { got, restore } = capture()
  try {
    recordClientError(posted, { root: ROOT })
    assert.deepEqual(got[0].error.stack, ['at <client> (/_next/static/chunks/main.js:7:8)'])
    for (const leak of ['AliceSmith', 'river-mint', 'password']) assert.ok(!JSON.stringify(got).includes(leak), `${leak} in the record`)
  } finally { restore() }
})

test('loaded scripts: same-origin /_next/static/ script tags and script resources only', () => {
  const w = {
    location: { pathname: '/app', origin: 'https://dazl.ai' }, fetch, addEventListener: () => {},
    document: { scripts: [{ src: 'https://dazl.ai/_next/static/chunks/main.js?v=1' }, { src: '' }, { src: 'https://cdn.evil.example/_next/static/x.js' }, { src: 'https://dazl.ai/other.js' }] },
    performance: { getEntriesByType: () => [{ name: 'https://dazl.ai/_next/static/chunks/app/page-1a2b.js', initiatorType: 'script' }, { name: 'https://dazl.ai/_next/static/css/a.css', initiatorType: 'link' }] },
  }
  assert.deepEqual([...loadedScripts(w)].sort(), ['/_next/static/chunks/app/page-1a2b.js', '/_next/static/chunks/main.js'])
  assert.deepEqual([...loadedScripts({ location: { pathname: '/' }, fetch, addEventListener: () => {} })], [])
})

test('review repro: a non-pattern password and name in the message reach neither the payload nor the record', () => {
  const msg = 'Login failed password=river-mint-secret customer=AliceSmith'
  const body = clientReport('error', new Error(msg), '/sign-in')
  const { got, restore } = capture()
  try {
    recordClientError({ ...JSON.parse(body), message: msg, stack: msg }, {})
    for (const leak of ['river-mint-secret', 'AliceSmith', 'password=', 'Login failed']) {
      assert.ok(!body.includes(leak), `${leak} in the browser payload`)
      assert.ok(!JSON.stringify(got).includes(leak), `${leak} in the record`)
    }
    assert.equal(got[0].error.message, 'browser error')
  } finally { restore() }
})

test('end to end in process: a thrown error with a name and a secret reaches neither the request nor the record', async () => {
  resetClientErrorReporting()
  const { got, restore } = capture()
  const posts: string[] = []
  const w = { location: { pathname: '/app/outreach', origin: 'https://dazl.ai' }, document: { scripts: [...LOADED].map(p => ({ src: `https://dazl.ai${p}` })) }, fetch: (async (_u: string, init: RequestInit) => { posts.push(String(init.body)); recordClientError(JSON.parse(String(init.body)), { root: ROOT }); return new Response(null, { status: 204 }) }) as unknown as typeof fetch, addEventListener: () => {} }
  try {
    assert.equal(reportClientError('boundary', leaky(), w), true)
    await new Promise(r => setTimeout(r, 0))
    assert.equal(posts.length, 1); assert.equal(got.length, 1)
    assert.equal(got[0].error.stack.length, 2, 'the two real bundle frames arrive')
    for (const leak of SENSITIVE) { assert.ok(!posts[0].includes(leak), `${leak} in the request`); assert.ok(!JSON.stringify(got[0]).includes(leak), `${leak} in the record`) }
  } finally { restore(); resetClientErrorReporting() }
})

test('the browser reporter: uncaught errors and rejections are posted once each, at most 5 per page, failures swallowed', async () => {
  resetClientErrorReporting()
  const posts: { url: string; body: Record<string, string>; keepalive?: boolean }[] = []
  const listeners: Record<string, (e: unknown) => void> = {}
  const w = {
    location: { pathname: '/app/leads' },
    fetch: (async (url: string, init: RequestInit) => { posts.push({ url, body: JSON.parse(String(init.body)), keepalive: init.keepalive }); throw new Error('offline') }) as unknown as typeof fetch,
    addEventListener: (t: string, f: (e: never) => void) => { listeners[t] = f as (e: unknown) => void },
  }
  installClientErrorReporting(w)
  installClientErrorReporting(w) // once only
  const boom = new TypeError('boom')
  listeners.error({ error: boom })
  listeners.error({ error: boom }) // the same report again: not resent
  listeners.unhandledrejection({ reason: 'plain string reason' })
  assert.equal(reportClientError('boundary', new RangeError('render'), w), true)
  // a missing chunk after a deploy is handled by lib/chunk-recovery.ts, not reported
  const chunk = new Error('Loading chunk 123 failed.'); chunk.name = 'ChunkLoadError'
  assert.equal(reportClientError('boundary', chunk, w), false)
  listeners.error({ message: 'Uncaught ChunkLoadError: Loading chunk 9 failed' })
  await new Promise(r => setTimeout(r, 0))
  assert.deepEqual(posts.map(p => [p.url, p.body.kind, p.body.type, p.body.path, p.keepalive]), [
    ['/api/client-errors', 'error', 'TypeError', '/app/leads', true],
    ['/api/client-errors', 'unhandledrejection', 'Error', '/app/leads', true],
    ['/api/client-errors', 'boundary', 'RangeError', '/app/leads', true],
  ])
  for (const k of ['error', 'boundary']) reportClientError(k as 'error', new SyntaxError('loop'), w)
  reportClientError('unhandledrejection', new EvalError('loop'), w); reportClientError('error', new URIError('loop'), w)
  assert.equal(posts.length, 5, 'at most 5 reports per page load')
  resetClientErrorReporting()
})

test('/api/client-errors through the real route file: same origin only, size limited, rate limited, tenant from the session', () => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/health-route-loader.mjs', '--test', './test/helpers/client-errors-runtime.mts'],
  { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.error, undefined, String(r.error))
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /CLIENT_ERRORS_ROUTE_OK/)
})
