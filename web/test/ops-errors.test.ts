// Structured error capture (lib/ops/errors.ts, lib/ops/request-error.ts): the record's shape, PII scrubbing, the
// tenant id, and the alert hook's throttling. Stubbed sinks and fetch only; nothing leaves the process.
import test from 'node:test'
import assert from 'node:assert/strict'
import { captureError, makeAlertHook, scrub, setErrorSinks, toRecord, type ErrorRecord } from '../lib/ops/errors.ts'
import { handleRequestError, sessionToken } from '../lib/ops/request-error.ts'

const PII = [
  'jane.doe@example.com', 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc', 'sk_live_51HxYzAbCdEfGh', 'whsec_AbCdEfGh1234',
  'sk-ant-api03-AbCdEfGhIjKl', 'postgres://dazl:hunter2@db.internal:5432/app', '203.0.113.7', '+1 (415) 555-0134',
  'a'.repeat(64), 'https://dazl.ai/api/unsubscribe?t=secret-token&e=jane@x.io',
]

test('scrub removes emails, auth headers, keys, DB URLs, IPs, phone numbers, long tokens and URL queries', () => {
  const out = scrub(`failed for ${PII.join(' and ')}`)
  for (const p of PII) assert.ok(!out.includes(p), `${p} leaked: ${out}`)
  for (const leak of ['hunter2', 'jane', 'secret-token', '555-0134']) assert.ok(!out.includes(leak), `${leak} leaked: ${out}`)
  assert.match(out, /https:\/\/dazl\.ai\/api\/unsubscribe\?\[query\]/) // the path survives, the query does not
  assert.equal(scrub('lead scoring failed: model returned 529'), 'lead scoring failed: model returned 529') // plain text untouched
})

test('a record has a fixed shape: where, tenant id, scrubbed error, fingerprint; nothing else', () => {
  const e = new Error(`stripe said no for jane.doe@example.com`, { cause: new TypeError('fetch failed for 203.0.113.7') })
  const r = toRecord(e, { source: 'route', where: '/api/billing/checkout?x=jane@x.io', method: 'POST', tenantId: '0123abcd', ref: 'evt_123' }, new Date(0))
  assert.deepEqual(Object.keys(r).sort(), ['error', 'fingerprint', 'level', 'method', 'ref', 'source', 'tenant', 'ts', 'where'])
  assert.equal(r.where, '/api/billing/checkout')
  assert.equal(r.tenant, '0123abcd')
  assert.equal(r.ref, 'evt_123')
  assert.equal(r.ts, '1970-01-01T00:00:00.000Z')
  assert.equal(r.error.name, 'Error')
  assert.equal(r.error.message, 'stripe said no for [email]')
  assert.deepEqual(r.error.cause, { name: 'TypeError', message: 'fetch failed for [ip]' })
  assert.ok(r.error.stack.length > 0 && r.error.stack.every(l => l.startsWith('at ')))
  assert.match(r.fingerprint, /^[0-9a-f]{16}$/)
  // the same failure at the same place groups together; a different place does not
  assert.equal(toRecord(e, { source: 'route', where: '/api/billing/checkout' }).fingerprint, toRecord(e, { source: 'route', where: '/api/billing/checkout' }).fingerprint)
  assert.notEqual(toRecord(e, { source: 'route', where: '/api/billing/portal' }).fingerprint, toRecord(e, { source: 'route', where: '/api/billing/checkout' }).fingerprint)
})

test('only opaque ids are kept as tenant or ref: an email passed by mistake is dropped', () => {
  const r = toRecord(new Error('x'), { source: 'worker', where: 'tick:replies', tenantId: 'jane@example.com', ref: 'a b' })
  assert.equal(r.tenant, null)
  assert.equal('ref' in r, false)
  assert.ok(!JSON.stringify(r).includes('jane'))
})

test('a thrown non-Error keeps only its type; an object is never serialized', () => {
  const r = toRecord({ email: 'jane@example.com', password: 'pw' }, { source: 'route', where: '/api/x' })
  assert.deepEqual(r.error, { name: 'object', message: '[non-error thrown]', stack: [] })
  assert.equal(toRecord('boom for jane@example.com', { source: 'route', where: '/api/x' }).error.message, 'boom for [email]')
})

test('captureError writes to every sink and never throws, even when a sink does', () => {
  const got: ErrorRecord[] = []
  const restore = setErrorSinks([() => { throw new Error('sink down') }, r => got.push(r)])
  try {
    const r = captureError(new Error('x'), { source: 'worker', where: 'tick:sequences', tenantId: 't1' })
    assert.equal(got.length, 1)
    assert.equal(got[0], r)
  } finally { restore() }
})

test('the default sink is one JSON line on stderr', () => {
  const lines: string[] = []
  const orig = process.stderr.write
  process.stderr.write = ((s: string) => { lines.push(String(s)); return true }) as typeof process.stderr.write
  try { captureError(new Error('db down for jane@example.com'), { source: 'route', where: '/api/leads', tenantId: 't1' }) } finally { process.stderr.write = orig }
  assert.equal(lines.length, 1)
  assert.ok(lines[0].endsWith('\n') && !lines[0].slice(0, -1).includes('\n'))
  const r = JSON.parse(lines[0])
  assert.equal(r.tenant, 't1')
  assert.equal(r.error.message, 'db down for [email]')
})

test('alert hook: off without an https URL; one alert per fingerprint per window; a global cap; failures swallowed', async () => {
  const sent: { url: string; body: ErrorRecord }[] = []
  const f = (async (url: string, init: RequestInit) => { sent.push({ url, body: JSON.parse(String(init.body)) }); return new Response('ok') }) as unknown as typeof fetch
  const rec = (where: string) => toRecord(new Error('x'), { source: 'route', where, tenantId: 't1' })
  makeAlertHook({ fetchImpl: f })(rec('/a'))
  makeAlertHook({ url: 'http://hooks.example.test/x', fetchImpl: f })(rec('/a'))
  await new Promise(r => setImmediate(r))
  assert.equal(sent.length, 0, 'no URL or plain http: no alert')

  let now = 0
  const hook = makeAlertHook({ url: 'https://hooks.example.test/x', fetchImpl: f, windowMs: 1000, maxPerWindow: 2, clock: () => now })
  hook(rec('/a')); hook(rec('/a')); hook(rec('/b')); hook(rec('/c'))
  await new Promise(r => setImmediate(r))
  assert.deepEqual(sent.map(s => s.body.where), ['/a', '/b'], 'repeat of /a throttled, /c over the cap')
  assert.equal(sent[0].url, 'https://hooks.example.test/x')
  assert.equal(sent[0].body.tenant, 't1')
  now = 1000
  hook(rec('/a'))
  await new Promise(r => setImmediate(r))
  assert.equal(sent.length, 3, 'a new window sends again')

  const failing = makeAlertHook({ url: 'https://hooks.example.test/x', fetchImpl: (async () => { throw new Error('down') }) as unknown as typeof fetch })
  failing(rec('/a'))
  await new Promise(r => setImmediate(r)) // an unhandled rejection here would fail the test run
})

test('request errors: the session cookie resolves to the tenant id; nothing else from the request is recorded', async () => {
  assert.equal(sessionToken({ cookie: 'a=1; dazl_session=tok123 ; b=2' }), 'tok123')
  assert.equal(sessionToken({ cookie: ['a=1', 'dazl_session=tok9'] }), 'tok9')
  assert.equal(sessionToken({}), undefined)
  const got: ErrorRecord[] = []
  const restore = setErrorSinks([r => got.push(r)])
  try {
    const looked: string[] = []
    const req = { path: '/api/leads/abc/confirm?email=jane@example.com', method: 'POST', headers: { cookie: 'dazl_session=tok123', 'x-forwarded-for': '203.0.113.7', authorization: 'Bearer secret' } }
    await handleRequestError(new Error('boom'), req, { routePath: '/api/leads/[lead]/confirm', routeType: 'route' }, { tenantFor: async t => { looked.push(t); return 'tenant-a' } })
    assert.deepEqual(looked, ['tok123'])
    assert.equal(got[0].tenant, 'tenant-a')
    assert.equal(got[0].where, '/api/leads/[lead]/confirm')
    assert.equal(got[0].source, 'route')
    const s = JSON.stringify(got[0])
    for (const leak of ['tok123', 'jane', '203.0.113.7', 'secret']) assert.ok(!s.includes(leak), `${leak} leaked`)

    // no route template: the path without its query; no cookie: no lookup
    await handleRequestError(new Error('boom'), { ...req, headers: {} }, { routeType: 'render' }, { tenantFor: async () => { throw new Error('must not be called') } })
    assert.equal(got[1].where, '/api/leads/abc/confirm')
    assert.equal(got[1].tenant, null)
    assert.equal(got[1].source, 'render')
  } finally { restore() }
})

test('request errors: a store that hangs or throws on the session lookup still records the error, without a tenant', async () => {
  const got: ErrorRecord[] = []
  const restore = setErrorSinks([r => got.push(r)])
  try {
    const req = { path: '/api/leads', method: 'GET', headers: { cookie: 'dazl_session=tok' } }
    const t0 = Date.now()
    await handleRequestError(new Error('a'), req, { routePath: '/api/leads', routeType: 'route' }, { tenantFor: () => new Promise(() => {}), timeoutMs: 50 })
    assert.ok(Date.now() - t0 < 1000)
    await handleRequestError(new Error('b'), req, { routePath: '/api/leads', routeType: 'route' }, { tenantFor: async () => { throw new Error('db down') } })
    assert.deepEqual(got.map(r => [r.error.message, r.tenant]), [['a', null], ['b', null]])
  } finally { restore() }
})
