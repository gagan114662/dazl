// Request ids and JSON request logs (lib/ops/request-log.ts, proxy.ts), and the request id on error records.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { isRequestId, newRequestId, requestLogLine, routeTemplate } from '../lib/ops/request-log.ts'
import { ROUTE_TEMPLATES } from '../lib/ops/routes.ts'
import { setErrorSinks, type ErrorRecord } from '../lib/ops/errors.ts'
import { handleRequestError } from '../lib/ops/request-error.ts'

test('request ids are random UUIDv4s; nothing else passes as one', () => {
  const a = newRequestId(), b = newRequestId()
  assert.ok(isRequestId(a) && isRequestId(b) && a !== b)
  for (const bad of ['', 'abc', '4155550134', 'jane@example.com', a.toUpperCase(), `${a}x`]) assert.equal(isRequestId(bad), false, bad)
})

test('a request log line has a fixed shape and carries the route template, never the caller\'s path text', () => {
  const l = requestLogLine(newRequestId(), 'PATCH', '/api/leads/jane@example.com/confirm?t=0123456789abcdef0123456789abcdef', new Date(0))
  assert.deepEqual(Object.keys(l).sort(), ['level', 'method', 'path', 'request_id', 'ts', 'type'])
  assert.equal(l.path, '/api/leads/[lead]/confirm')
  assert.equal(l.ts, '1970-01-01T00:00:00.000Z')
  assert.equal(requestLogLine(newRequestId(), 'BREW', '/api/leads').method, 'OTHER')
})

// Review repro (f45cc5e): NextURL keeps the path percent-encoded, so an encoded email went to stdout unchanged.
test('encoded, malformed, double-encoded and unknown paths never reach the log; known routes stay readable', () => {
  const hostile = [
    '/api/leads/jane%40example.com/confirm', '/api/unknown/user.name%40company.example', '/api/leads/%2B1%20415%20555%200134/warm-path',
    '/api/campaigns/sk_live_0123456789abcdefghij', '/api/replies/%E0%A4%A', '/api/replies/jane%2540example.com',
    '/api/leads/jane%40example.com', '/api/scan/csv/..%2F..%2Fetc%2Fpasswd', '/app/leads/jane', '/api/jane.doe@example.com',
    '/api//leads///x%00y', '/api/outreach/' + 'a'.repeat(5000),
  ]
  for (const p of hostile) {
    const out = requestLogLine(newRequestId(), 'GET', p).path // the only field derived from the request path (the id is a random UUID)
    for (const leak of ['jane', 'company', '415', '555', 'sk_live', '%', 'etc', 'passwd', 'aaaa']) assert.ok(!out.includes(leak), `${p} -> ${out}`)
  }
  assert.equal(routeTemplate('/api/leads/jane%40example.com/confirm'), '/api/leads/[lead]/confirm') // the template, not the value
  assert.equal(routeTemplate('/api/unknown/user.name%40company.example'), '/api/[unknown]')
  assert.equal(routeTemplate('/api/leads/jane%40example.com'), '/api/[unknown]') // no route at that depth
  assert.equal(routeTemplate('/app/leads/jane'), '/app/[unknown]')
  // readability: every real route logs as itself, statics win over dynamics
  assert.equal(routeTemplate('/api/outreach/autopilot'), '/api/outreach/autopilot')
  assert.equal(routeTemplate('/api/outreach/0a1b2c3d4e5f60718293a4b5'), '/api/outreach/[id]')
  assert.equal(routeTemplate('/api/scan/csv/0a1b2c3d4e5f60718293a4b5'), '/api/scan/csv/[batch]')
  assert.equal(routeTemplate('/api/health/ready'), '/api/health/ready')
  assert.equal(routeTemplate('/app'), '/app')
  assert.equal(routeTemplate('/app/campaigns/x1'), '/app/campaigns/[id]')
  for (const t of ROUTE_TEMPLATES) assert.equal(routeTemplate(t.replace(/\[[a-z]+\]/g, 'v1')), t, t)
})

test('the route list matches the route files under app/ (add new routes to lib/ops/routes.ts)', () => {
  const root = new URL('../app/', import.meta.url).pathname
  const found: string[] = []
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = path.join(dir, f)
      if (statSync(p).isDirectory()) walk(p)
      else if ((f === 'route.ts' && p.includes('/app/api/')) || (f === 'page.tsx' && p.includes('/app/app'))) found.push('/' + path.relative(root, dir))
    }
  }
  walk(path.join(root, 'api')); walk(path.join(root, 'app'))
  assert.deepEqual([...ROUTE_TEMPLATES].sort(), found.sort())
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
  { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 120000 }) // as the other child-process route tests: the full suite runs files in parallel
  assert.equal(r.error, undefined, String(r.error)) // a spawn failure or timeout names itself
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# pass 2\b/)
  assert.match(r.stdout, /PROXY_OK/)
})
