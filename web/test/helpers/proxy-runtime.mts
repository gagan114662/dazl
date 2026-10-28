// Runs the real proxy.ts (see test/request-log.test.ts): request ids, JSON request log lines, the /app redirect.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { setRequestLogWriter, isRequestId } from '../../lib/ops/request-log.ts'

const { proxy, config } = await import('../../proxy.ts')
const lines: string[] = []
setRequestLogWriter(l => lines.push(l))
const req = (path: string, headers: Record<string, string> = {}, method = 'GET') => new NextRequest(`https://dazl.test${path}`, { method, headers })

test('proxy: a fresh request id per request, forwarded to the route and returned; one scrubbed JSON log line', () => {
  assert.deepEqual(config.matcher, ['/app/:path*', '/api/:path*'])
  const res = proxy(req('/api/leads?email=jane@example.com&t=secret', { 'x-request-id': 'evil-+1 415 555 0134', cookie: 'dazl_session=tok' }))
  const id = res.headers.get('x-request-id')!
  assert.ok(isRequestId(id), id) // never the caller's value
  assert.equal(res.headers.get('x-middleware-request-x-request-id'), id) // the route sees the same id
  assert.match(res.headers.get('x-middleware-override-headers') ?? '', /x-request-id/)
  assert.equal(lines.length, 1)
  const l = JSON.parse(lines[0])
  assert.deepEqual(Object.keys(l).sort(), ['level', 'method', 'path', 'request_id', 'ts', 'type'])
  assert.deepEqual([l.level, l.type, l.request_id, l.method, l.path], ['info', 'request', id, 'GET', '/api/leads'])
  for (const leak of ['jane', 'secret', '555', 'evil', 'tok']) assert.ok(!lines[0].includes(leak), leak)

  const res2 = proxy(req('/api/leads/0123456789abcdef0123456789abcdef/confirm', {}, 'POST'))
  assert.notEqual(res2.headers.get('x-request-id'), id)
  assert.equal(JSON.parse(lines[1]).path, '/api/leads/[id]/confirm') // long ids and tokens never reach the log

  proxy(req('/api/health/live')); proxy(req('/api/ready'))
  assert.equal(lines.length, 2) // probes: no log line
})

test('proxy: /app still redirects signed-out visitors and lets a session through, with a request id either way', () => {
  const out = proxy(req('/app/leads'))
  assert.equal(out.status, 307)
  assert.equal(new URL(out.headers.get('location')!).pathname, '/sign-in')
  assert.ok(isRequestId(out.headers.get('x-request-id')))
  const inn = proxy(req('/app/leads', { cookie: 'dazl_session=abc' }))
  assert.equal(inn.headers.get('location'), null)
  assert.ok(isRequestId(inn.headers.get('x-request-id')))
  console.log('PROXY_OK')
})
