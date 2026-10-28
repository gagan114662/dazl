// Browser error monitoring: the report guard (lib/ops/client-errors.ts), the endpoint (app/api/client-errors, run in a
// child process through the real route file) and the browser reporter (lib/client-error-report.ts) with a fake window.
// Nothing leaves the process: records go to a test sink, the browser's fetch is a stub.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { setErrorSinks, type ErrorRecord } from '../lib/ops/errors.ts'
import { recordClientError } from '../lib/ops/client-errors.ts'
import { installClientErrorReporting, reportClientError, resetClientErrorReporting } from '../lib/client-error-report.ts'

const capture = () => { const got: ErrorRecord[] = []; const restore = setErrorSinks([r => got.push(r)]); return { got, restore } }

test('a report becomes a scrubbed client record: route template, bounded frames, no caller text beyond the scrub', () => {
  const { got, restore } = capture()
  try {
    const r = recordClientError({
      kind: 'error', name: 'TypeError', path: '/app/campaigns/0123456789abcdef0123456789abcdef?email=jane@example.com',
      message: "Cannot read properties of undefined (reading 'x') for jane@example.com sk_live_abcdefghijklmnop",
      stack: ['TypeError: boom', ...Array.from({ length: 20 }, (_, i) => `    at f${i} (https://dazl.ai/_next/static/chunks/a.js?t=secret:1:${i})`)].join('\n'),
    }, { tenantId: 'a'.repeat(32), requestId: 'not-a-request-id' })
    assert.ok(r && r !== 'invalid')
    assert.equal(got.length, 1)
    const g = got[0]
    assert.deepEqual([g.source, g.where, g.tenant, g.error.name], ['client', 'error:/app/campaigns/[id]', 'a'.repeat(32), 'TypeError'])
    assert.equal(g.error.stack.length, 8)
    assert.equal('request_id' in g, false)
    const s = JSON.stringify(g)
    for (const leak of ['jane', 'sk_live', 'secret', '0123456789abcdef0123456789abcdef']) assert.ok(!s.includes(leak), leak)
    // Firefox/Safari frames are kept in the same form; public pages are named exactly; unknown paths are not echoed
    recordClientError({ kind: 'unhandledrejection', name: 'Error', message: 'x', path: '/sign-in', stack: 'load@https://dazl.ai/_next/a.js:3:9\n@https://dazl.ai/_next/b.js:1:2' }, {})
    assert.deepEqual([got[1].where, got[1].error.stack], ['unhandledrejection:/sign-in', ['at load (https://dazl.ai/_next/a.js:3:9)', 'at <anonymous> (https://dazl.ai/_next/b.js:1:2)']])
    recordClientError({ kind: 'boundary', name: 'Account12345Error', message: 'x', path: '/jane@example.com/profile' }, {})
    assert.deepEqual([got[2].where, got[2].error.name], ['boundary:/[unknown]', '[unrecognized-name]'])
    // not a report: nothing recorded
    for (const bad of [null, 'x', [], { kind: 'other', path: '/app' }, { kind: 'error' }, { kind: 'error', path: 'https://evil.example/' }]) assert.equal(recordClientError(bad, {}), 'invalid')
    assert.equal(got.length, 3)
  } finally { restore() }
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
  listeners.error({ error: new TypeError('boom') })
  listeners.error({ error: new TypeError('boom') }) // the same error again: not resent
  listeners.unhandledrejection({ reason: 'plain string reason' })
  assert.equal(reportClientError('boundary', new RangeError('render'), w), true)
  // a missing chunk after a deploy is handled by lib/chunk-recovery.ts, not reported
  const chunk = new Error('Loading chunk 123 failed.'); chunk.name = 'ChunkLoadError'
  assert.equal(reportClientError('boundary', chunk, w), false)
  listeners.error({ message: 'Uncaught ChunkLoadError: Loading chunk 9 failed' })
  await new Promise(r => setTimeout(r, 0))
  assert.deepEqual(posts.map(p => [p.url, p.body.kind, p.body.name, p.body.path, p.keepalive]), [
    ['/api/client-errors', 'error', 'TypeError', '/app/leads', true],
    ['/api/client-errors', 'unhandledrejection', 'string', '/app/leads', true],
    ['/api/client-errors', 'boundary', 'RangeError', '/app/leads', true],
  ])
  for (let i = 0; i < 10; i++) reportClientError('error', new Error(`loop ${i}`), w)
  assert.equal(posts.length, 5, 'at most 5 reports per page load')
  resetClientErrorReporting()
})

test('/api/client-errors through the real route file: same origin only, bounded, rate limited, tenant from the session', () => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/health-route-loader.mjs', '--test', './test/helpers/client-errors-runtime.mts'],
  { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.error, undefined, String(r.error))
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /CLIENT_ERRORS_ROUTE_OK/)
})
