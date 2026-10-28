// The Sentry-compatible alert hook (lib/ops/errors.ts, SENTRY_DSN): off without a DSN, the envelope it sends, and that
// it carries the scrubbed record only. Stubbed fetch; nothing leaves the process.
import test from 'node:test'
import assert from 'node:assert/strict'
import { captureError, makeSentryHook, parseSentryDsn, setErrorSinks, toRecord, toSentryEnvelope } from '../lib/ops/errors.ts'

const TA = '0123456789abcdef0123456789abcdef'
const DSN = 'https://abc123public@o42.ingest.sentry.example.test/4507'
type Sent = { url: string; headers: Record<string, string>; body: string }
const stub = (sent: Sent[]) => (async (url: string, init: RequestInit) => {
  sent.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) }); return new Response('{}')
}) as unknown as typeof fetch
const tick = () => new Promise(r => setImmediate(r))
const parse = (body: string) => body.split('\n').map(l => JSON.parse(l))

test('DSN parsing: https with a public key and a numeric project only; a path prefix is kept', () => {
  assert.deepEqual(parseSentryDsn(DSN), { endpoint: 'https://o42.ingest.sentry.example.test/api/4507/envelope/', publicKey: 'abc123public', dsn: DSN })
  assert.equal(parseSentryDsn('https://k@glitchtip.example.test/sub/path/7')!.endpoint, 'https://glitchtip.example.test/sub/path/api/7/envelope/')
  for (const bad of [undefined, '', 'not a url', 'http://k@sentry.example.test/1', 'https://sentry.example.test/1', 'https://k@sentry.example.test/', 'https://k@sentry.example.test/abc']) {
    assert.equal(parseSentryDsn(bad), null, String(bad))
  }
})

test('without a DSN (or with a bad one) the hook sends nothing', async () => {
  const sent: Sent[] = []
  for (const dsn of [undefined, '', 'http://k@sentry.example.test/1']) makeSentryHook({ dsn, fetchImpl: stub(sent) })(toRecord(new Error('x'), { source: 'route', where: '/api/x' }))
  await tick()
  assert.equal(sent.length, 0)
})

test('the envelope: header, event item, the record mapped onto a Sentry event; no field the record does not hold', () => {
  const e = new Error('db down for jane.doe@example.com', { cause: new TypeError('connect 203.0.113.7') })
  const r = toRecord(e, { source: 'route', where: '/api/leads/[lead]/confirm', method: 'POST', tenantId: TA, requestId: '0b9f3c2e-4d5a-4b6c-8d7e-9f0a1b2c3d4e' }, new Date(1_700_000_000_000))
  const [head, item, ev] = parse(toSentryEnvelope(r, parseSentryDsn(DSN)!, { environment: 'production', release: 'abc1234' }, new Date(1_700_000_001_000)))
  assert.match(head.event_id, /^[0-9a-f]{32}$/)
  assert.deepEqual(head, { event_id: head.event_id, sent_at: '2023-11-14T22:13:21.000Z', dsn: DSN })
  assert.deepEqual(item, { type: 'event' })
  assert.equal(ev.event_id, head.event_id)
  assert.equal(ev.timestamp, 1_700_000_000)
  assert.deepEqual([ev.level, ev.platform, ev.logger, ev.transaction, ev.environment, ev.release], ['error', 'node', 'route', '/api/leads/[lead]/confirm', 'production', 'abc1234'])
  assert.deepEqual(ev.fingerprint, [r.fingerprint], 'grouped by the record fingerprint')
  assert.deepEqual(ev.tags, { source: 'route', where: '/api/leads/[lead]/confirm', method: 'POST', request_id: '0b9f3c2e-4d5a-4b6c-8d7e-9f0a1b2c3d4e' })
  assert.deepEqual(ev.user, { id: TA })
  assert.deepEqual(ev.exception, { values: [{ type: 'Error', value: 'db down for [email]' }] })
  assert.deepEqual(ev.extra.cause, { name: 'TypeError', message: 'connect [ip]' })
  assert.deepEqual(ev.extra.stack, r.error.stack)
  const all = JSON.stringify(ev)
  for (const leak of ['jane', '203.0.113.7']) assert.ok(!all.includes(leak), `${leak} leaked`)
  // no tenant, no user block
  const anon = parse(toSentryEnvelope(toRecord(new Error('x'), { source: 'worker', where: 'tick' }), parseSentryDsn(DSN)!))[2]
  assert.equal('user' in anon, false)
  assert.equal('environment' in anon, false)
})

test('the hook POSTs to the project envelope endpoint with Sentry auth, throttled like the webhook', async () => {
  const sent: Sent[] = []
  let now = 0
  const hook = makeSentryHook({ dsn: DSN, fetchImpl: stub(sent), windowMs: 1000, maxPerWindow: 2, clock: () => now })
  const rec = (where: string) => toRecord(new Error('x'), { source: 'route', where })
  hook(rec('/a')); hook(rec('/a')); hook(rec('/b')); hook(rec('/c'))
  await tick()
  assert.deepEqual(sent.map(s => parse(s.body)[2].transaction), ['/a', '/b'], 'repeat throttled, third over the cap')
  assert.equal(sent[0].url, 'https://o42.ingest.sentry.example.test/api/4507/envelope/')
  assert.equal(sent[0].headers['content-type'], 'application/x-sentry-envelope')
  assert.equal(sent[0].headers['x-sentry-auth'], 'Sentry sentry_version=7, sentry_key=abc123public, sentry_client=dazl-ops/1.0')
  now = 1000
  hook(rec('/a'))
  await tick()
  assert.equal(sent.length, 3)
  makeSentryHook({ dsn: DSN, fetchImpl: (async () => { throw new Error('down') }) as unknown as typeof fetch })(rec('/a'))
  await tick() // a rejected send must not surface as an unhandled rejection
})

test('captureError reaches Sentry when SENTRY_DSN is set, and nothing is sent when it is not', async () => {
  const sent: Sent[] = []
  const origFetch = globalThis.fetch
  const restoreSinks = setErrorSinks([])
  const saved = { dsn: process.env.SENTRY_DSN, hook: process.env.OPS_ALERT_WEBHOOK_URL }
  globalThis.fetch = stub(sent)
  try {
    delete process.env.OPS_ALERT_WEBHOOK_URL
    delete process.env.SENTRY_DSN
    captureError(new Error('no dsn'), { source: 'route', where: '/api/none' })
    await tick()
    assert.equal(sent.length, 0, 'no DSN: no-op')
    process.env.SENTRY_DSN = DSN
    captureError(new Error('with dsn for jane@example.com'), { source: 'route', where: '/api/with', tenantId: TA })
    await tick()
    assert.equal(sent.length, 1)
    const ev = parse(sent[0].body)[2]
    assert.equal(ev.transaction, '/api/with')
    assert.equal(ev.exception.values[0].value, 'with dsn for [email]')
  } finally {
    globalThis.fetch = origFetch
    restoreSinks()
    if (saved.dsn === undefined) delete process.env.SENTRY_DSN; else process.env.SENTRY_DSN = saved.dsn
    if (saved.hook !== undefined) process.env.OPS_ALERT_WEBHOOK_URL = saved.hook
  }
})
