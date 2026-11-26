import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { register } from 'node:module'
import { test } from 'node:test'
import 'next/dist/server/node-environment-baseline.js'
import nextTesting from 'next/experimental/testing/server.js'
import nextConfig from '../next.config.ts'
import { ROUTE_TEMPLATES } from '../lib/ops/routes.ts'
import { withJar } from './helpers/pg-session-headers.ts'

const origin = 'http://127.0.0.1'

test('#1796 public Terms response config enables HSTS preload and denies framing', async () => {
  const { headers } = await nextTesting.unstable_getResponseFromNextConfig({
    url: origin + '/terms', nextConfig,
  })
  const hsts = (headers.get('strict-transport-security') ?? '').toLowerCase().split(';').map(s => s.trim())
  assert.ok(hsts.includes('preload'), 'missing HSTS preload')
  assert.ok(hsts.includes('includesubdomains'), 'preload requires includeSubDomains')
  const maxAge = hsts.find(s => /^max-age=\d+$/.test(s))
  assert.ok(maxAge && Number(maxAge.slice(8)) >= 31536000, 'preload requires at least one year')
  const csp = headers.get('content-security-policy')?.trim()
  assert.ok(csp, 'missing CSP')
  const framing = csp.split(';').map(s => s.trim()).find(s => /^frame-ancestors\b/i.test(s))
  if (framing) assert.match(framing, /^frame-ancestors\s+'none'$/i)
  else assert.equal(headers.get('x-frame-options')?.toUpperCase(), 'DENY')
})

test('#1796 registered internal and worker GET handlers reject anonymous requests', async t => {
  register('./helpers/audit-session-loader.mjs', import.meta.url)
  const { NextRequest } = await import('next/server')
  const internal = await import('../app/api/internal/spend-caps/route.ts')
  const workers = await import('../app/api/workers/route.ts')
  const req = new NextRequest(origin + '/api/internal/spend-caps')
  const original = process.env.AUTOPILOT_TICK_SECRET
  t.after(() => {
    if (original === undefined) delete process.env.AUTOPILOT_TICK_SECRET
    else process.env.AUTOPILOT_TICK_SECRET = original
  })
  process.env.AUTOPILOT_TICK_SECRET = randomUUID()
  const response = await internal.GET(req)
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: 'Not found' })
  assert.equal((await withJar(new Map(), () => workers.GET())).status, 401)
})

test('#1796 singular worker and admin namespaces are unregistered, not tested guards', () => {
  assert.deepEqual(ROUTE_TEMPLATES.filter(path => /^\/api\/(?:admin|worker)(?:\/|$)/.test(path)), [])
})
