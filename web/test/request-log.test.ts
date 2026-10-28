// Request ids and JSON request logs (lib/ops/request-log.ts, proxy.ts), and the request id on error records.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isRequestId, newRequestId, requestLogLine } from '../lib/ops/request-log.ts'
import { setErrorSinks, type ErrorRecord } from '../lib/ops/errors.ts'
import { handleRequestError } from '../lib/ops/request-error.ts'

test('request ids are random UUIDv4s; nothing else passes as one', () => {
  const a = newRequestId(), b = newRequestId()
  assert.ok(isRequestId(a) && isRequestId(b) && a !== b)
  for (const bad of ['', 'abc', '4155550134', 'jane@example.com', a.toUpperCase(), `${a}x`]) assert.equal(isRequestId(bad), false, bad)
})

test('a request log line has a fixed shape and no query, token or email', () => {
  const l = requestLogLine(newRequestId(), 'PATCH', '/api/unsubscribe/jane@example.com?t=0123456789abcdef0123456789abcdef', new Date(0))
  assert.deepEqual(Object.keys(l).sort(), ['level', 'method', 'path', 'request_id', 'ts', 'type'])
  assert.equal(l.path, '/api/unsubscribe/[email]')
  assert.equal(l.ts, '1970-01-01T00:00:00.000Z')
  assert.equal(requestLogLine(newRequestId(), 'BREW', '/api/x').method, 'OTHER')
  assert.equal(requestLogLine(newRequestId(), 'GET', '/api/scan/csv/0a1b2c3d4e5f60718293a4b5').path, '/api/scan/csv/[id]')
  assert.equal(requestLogLine(newRequestId(), 'GET', '/api/replies/r4155550134').path, '/api/replies/[id]')
  assert.equal(requestLogLine(newRequestId(), 'GET', '/api/health/ready').path, '/api/health/ready')
})

test('error records carry the request id from proxy.ts, and only when it has the UUID shape', async () => {
  const got: ErrorRecord[] = []
  const restore = setErrorSinks([r => got.push(r)])
  try {
    const id = newRequestId()
    const base = { path: '/api/leads', method: 'GET' }
    await handleRequestError(new Error('x'), { ...base, headers: { 'x-request-id': id } }, { routePath: '/api/leads', routeType: 'route' }, { tenantFor: async () => null })
    await handleRequestError(new Error('x'), { ...base, headers: { 'x-request-id': 'jane-4155550134' } }, { routePath: '/api/leads', routeType: 'route' }, { tenantFor: async () => null })
    assert.equal(got[0].request_id, id)
    assert.equal('request_id' in got[1], false)
    assert.ok(!JSON.stringify(got[1]).includes('4155550134'))
  } finally { restore() }
})

test('proxy.ts: ids, log lines and the /app redirect through the real file', () => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/health-route-loader.mjs', '--test', './test/helpers/proxy-runtime.mts'],
  { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 60000 })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# pass 2\b/)
  assert.match(r.stdout, /PROXY_OK/)
})
