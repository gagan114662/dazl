// Structured error capture (lib/ops/errors.ts, lib/ops/request-error.ts): the record's shape, PII scrubbing, the
// tenant id, and the alert hook's throttling. Stubbed sinks and fetch only; nothing leaves the process.
import test from 'node:test'
import assert from 'node:assert/strict'
import { captureError, makeAlertHook, scrub, setErrorSinks, toRecord, type ErrorContext, type ErrorRecord } from '../lib/ops/errors.ts'

const TA = '0123456789abcdef0123456789abcdef' // a users.id: 32 lowercase hex
const EVT = 'evt_1PqRsTuVwXyZaBcDeFgHiJkL'
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
  const r = toRecord(e, { source: 'route', where: '/api/billing/checkout?x=jane@x.io', method: 'POST', tenantId: TA, ref: EVT }, new Date(0))
  assert.deepEqual(Object.keys(r).sort(), ['error', 'fingerprint', 'level', 'method', 'ref', 'source', 'tenant', 'ts', 'where'])
  assert.equal(r.where, '/api/billing/checkout')
  assert.equal(r.tenant, TA)
  assert.equal(r.ref, EVT)
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

test('every emitted field is scrubbed or shape-checked: PII in a name, cause name, id, method or where never comes out (review repros)', () => {
  const PII_EMAIL = 'synthetic.owner@example.test'
  const named = (name: string, msg = 'x') => Object.assign(new Error(msg), { name })
  const e = named(`Request for ${PII_EMAIL}`, 'failed')
  e.cause = named(`Lookup of ${PII_EMAIL}`)
  const hostile: ErrorContext[] = [
    { source: 'route', where: '/api/x', tenantId: '1234567890', ref: 'SyntheticPerson' }, // phone-shaped tenant, name-shaped ref
    { source: 'route', where: `/api/unsubscribe/${PII_EMAIL}`, method: `GET ${PII_EMAIL}`, tenantId: PII_EMAIL, ref: PII_EMAIL },
    { source: 'route', where: 'tick:Jane Doe +1 415 555 0134', tenantId: 'SyntheticPerson', ref: 'evt_SyntheticPersonNameOfOwner' },
    { source: `route ${PII_EMAIL}` as ErrorContext['source'], where: '/api/x' },
  ]
  const leaks = [PII_EMAIL, 'synthetic.owner', '1234567890', 'SyntheticPerson', 'Jane', '555']
  // Pinned to the instant that once failed CI: a capture time ending in .555Z holds the planted phone fragment.
  const AT = new Date('2026-10-29T16:43:53.555Z')
  for (const ctx of hostile) {
    const r = toRecord(e, ctx, AT)
    // ts is the capture time, not input: only it is left out; every input-derived field is still checked.
    const out = JSON.stringify({ ...r, ts: undefined })
    assert.equal(r.ts, AT.toISOString())
    for (const leak of leaks) assert.ok(!out.includes(leak), `${leak} leaked from ${JSON.stringify(ctx)}: ${out}`)
    assert.equal(r.error.name, '[unrecognized-name]')
    assert.equal(r.error.cause?.name, '[unrecognized-name]')
    assert.equal(r.tenant, null)
    assert.equal('ref' in r, false)
    assert.equal('method' in r, false)
  }
  assert.equal(toRecord(e, hostile[1]).where, '[unrecognized]')
  assert.equal(toRecord(e, hostile[2]).where, '[unrecognized]')
  assert.equal(toRecord(e, hostile[3]).source, 'process')
  // the alert hook posts the same record, so it is equally clean
  const posted: string[] = []
  const hook = makeAlertHook({ url: 'https://hooks.example.test/x', fetchImpl: (async (_u: string, init: RequestInit) => { posted.push(String(init.body)); return new Response('ok') }) as unknown as typeof fetch })
  hook(toRecord(e, hostile[0]))
  return new Promise<void>(res => setImmediate(() => {
    assert.equal(posted.length, 1)
    for (const leak of leaks) assert.ok(!posted[0].includes(leak), `${leak} leaked to the alert hook`)
    res()
  }))
})

// Review repro: a class-shaped name can still carry a sensitive value; shape alone is not enough, for the error and its cause.
test('a class-shaped name carrying a phone-shaped number or a token is replaced, for the error and its cause', () => {
  for (const n of ['Account1234567890Error', 'User4155550134Exception', `Tok${'a'.repeat(40)}Error`, 'Ip2030113Error']) {
    const e = Object.assign(new Error('failure'), { name: n, cause: Object.assign(new Error('c'), { name: n }) })
    const r = toRecord(e, { source: 'route', where: '/api/x' })
    assert.equal(r.error.name, '[unrecognized-name]', n)
    assert.equal(r.error.cause?.name, '[unrecognized-name]', n)
    assert.ok(!JSON.stringify(r).includes(n), n)
  }
})

test('valid shapes pass: error class names, this app\'s own error classes, users.id, Stripe event ids, methods, route templates', () => {
  const r = toRecord(Object.assign(new TypeError('x'), { cause: Object.assign(new Error('y'), { name: 'StaleLeaseWrite' }) }),
    { source: 'route', where: '/api/leads/[lead]/confirm', method: 'DELETE', tenantId: TA, ref: EVT })
  assert.deepEqual([r.error.name, r.error.cause?.name, r.where, r.method, r.tenant, r.ref], ['TypeError', 'StaleLeaseWrite', '/api/leads/[lead]/confirm', 'DELETE', TA, EVT])
  for (const n of ['TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError', 'AggregateError', 'DOMException', 'DatabaseError', 'AbortError', 'TimeoutError', 'GmailSendError', 'LeaseLost', 'RaceLost', 'ScanStopped', 'ScanTimedOut', 'SpendRefused', 'StaleLeaseWrite', 'StatementFailedInTx', 'Timeout']) assert.equal(toRecord(Object.assign(new Error('x'), { name: n }), { source: 'worker', where: 'tick' }).error.name, n)
  assert.equal(toRecord(new Error('x'), { source: 'worker', where: 'tick:index-checks' }).where, 'tick:index-checks')
  assert.equal(toRecord(new Error('x'), { source: 'worker', where: 'tick', tenantId: TA.toUpperCase() }).tenant, null) // ids are lowercase hex
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
    const r = captureError(new Error('x'), { source: 'worker', where: 'tick:sequences', tenantId: TA })
    assert.equal(got.length, 1)
    assert.equal(got[0], r)
  } finally { restore() }
})

test('the default sink is one JSON line on stderr', () => {
  const lines: string[] = []
  const orig = process.stderr.write
  process.stderr.write = ((s: string) => { lines.push(String(s)); return true }) as typeof process.stderr.write
  try { captureError(new Error('db down for jane@example.com'), { source: 'route', where: '/api/leads', tenantId: TA }) } finally { process.stderr.write = orig }
  assert.equal(lines.length, 1)
  assert.ok(lines[0].endsWith('\n') && !lines[0].slice(0, -1).includes('\n'))
  const r = JSON.parse(lines[0])
  assert.equal(r.tenant, TA)
  assert.equal(r.error.message, 'db down for [email]')
})

test('alert hook: off without an https URL; one alert per fingerprint per window; a global cap; failures swallowed', async () => {
  const sent: { url: string; body: ErrorRecord }[] = []
  const f = (async (url: string, init: RequestInit) => { sent.push({ url, body: JSON.parse(String(init.body)) }); return new Response('ok') }) as unknown as typeof fetch
  const rec = (where: string) => toRecord(new Error('x'), { source: 'route', where, tenantId: TA })
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
  assert.equal('tenant' in sent[0].body, false, 'the tenant stays in the local log; it is not on the allowlist')
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
    await handleRequestError(new Error('boom'), req, { routePath: '/api/leads/[lead]/confirm', routeType: 'route' }, { tenantFor: async t => { looked.push(t); return TA } })
    assert.deepEqual(looked, ['tok123'])
    assert.equal(got[0].tenant, TA)
    assert.equal(got[0].where, '/api/leads/[lead]/confirm')
    assert.equal(got[0].source, 'route')
    const s = JSON.stringify(got[0])
    for (const leak of ['tok123', 'jane', '203.0.113.7', 'secret']) assert.ok(!s.includes(leak), `${leak} leaked`)

    // no route template: never the concrete path (its segments are caller data); no cookie: no lookup
    await handleRequestError(new Error('boom'), { ...req, path: '/u/jane@example.com', headers: {} }, { routeType: 'render' }, { tenantFor: async () => { throw new Error('must not be called') } })
    assert.equal(got[1].where, '[unknown-route]')
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
