// The Sentry-compatible alert hook (lib/ops/errors.ts, SENTRY_DSN) and the alert webhook: off without a destination, the
// envelope they send, and that what leaves is the ALLOWLIST only (error type, frames, route, release, environment), so
// no message text, name, email, token or note reaches either. Stubbed fetch; nothing leaves the process.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { APP_ERROR_CLASSES, captureError, deployment, makeAlertHook, makeSentryHook, outboundFrames, parseSentryDsn, setErrorSinks, toRecord, toSentryEnvelope } from '../lib/ops/errors.ts'

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

test('the envelope: header, event item, and only the allowlisted fields of the record', () => {
  const e = new Error('db down for jane.doe@example.com', { cause: new TypeError('connect 203.0.113.7') })
  const r = toRecord(e, { source: 'route', where: '/api/leads/[lead]/confirm', method: 'POST', tenantId: TA, requestId: '0b9f3c2e-4d5a-4b6c-8d7e-9f0a1b2c3d4e' }, new Date(1_700_000_000_000))
  const [head, item, ev] = parse(toSentryEnvelope(r, parseSentryDsn(DSN)!, { environment: 'production', release: 'abc1234' }, new Date(1_700_000_001_000)))
  assert.deepEqual(Object.keys(ev).sort(), ['environment', 'event_id', 'exception', 'fingerprint', 'level', 'logger', 'platform', 'release', 'tags', 'timestamp', 'transaction'])
  assert.match(head.event_id, /^[0-9a-f]{32}$/)
  assert.deepEqual(head, { event_id: head.event_id, sent_at: '2023-11-14T22:13:21.000Z', dsn: DSN })
  assert.deepEqual(item, { type: 'event' })
  assert.equal(ev.event_id, head.event_id)
  assert.equal(ev.timestamp, 1_700_000_000)
  assert.deepEqual([ev.level, ev.platform, ev.logger, ev.transaction, ev.environment, ev.release], ['error', 'node', 'route', '/api/leads/[lead]/confirm', 'production', 'abc1234'])
  assert.deepEqual(ev.fingerprint, [r.fingerprint], 'grouped by the record fingerprint')
  assert.deepEqual(ev.tags, { source: 'route', where: '/api/leads/[lead]/confirm', method: 'POST', request_id: '0b9f3c2e-4d5a-4b6c-8d7e-9f0a1b2c3d4e' })
  assert.equal(ev.exception.values.length, 1)
  assert.deepEqual(Object.keys(ev.exception.values[0]).sort(), ['stacktrace', 'type'], 'no message value')
  assert.equal(ev.exception.values[0].type, 'Error')
  assert.ok(ev.exception.values[0].stacktrace.frames.length > 0)
  for (const f of ev.exception.values[0].stacktrace.frames) assert.deepEqual(Object.keys(f).sort(), ['colno', 'filename', 'lineno'])
  const all = JSON.stringify(ev)
  for (const leak of ['jane', 'down', 'connect', '203.0.113.7', TA]) assert.ok(!all.includes(leak), `${leak} leaked`)
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
    assert.equal('value' in ev.exception.values[0], false)
    assert.ok(!sent[0].body.includes('with dsn') && !sent[0].body.includes(TA))
    assert.equal(ev.environment, 'production')
  } finally {
    globalThis.fetch = origFetch
    restoreSinks()
    if (saved.dsn === undefined) delete process.env.SENTRY_DSN; else process.env.SENTRY_DSN = saved.dsn
    if (saved.hook !== undefined) process.env.OPS_ALERT_WEBHOOK_URL = saved.hook
  }
})

// Instinct's review (Sentry hold): the pattern scrub cannot recognise every name, secret or note, so test that arbitrary
// ones never reach either outgoing destination, wherever they sit in the error.
const NAME = 'Priya Venkataraman', EMAIL = 'priya.v@harbourdental.example', TOKEN = 'q7Rk2mZp9XwB4vNf8LtY3sHd6JcE1aUo'
const NOTE = 'Lead note: owner said budget frees up after the merger, call Tuesday'
const SENSITIVE = [NAME, 'Priya', 'Venkataraman', EMAIL, 'harbourdental', TOKEN, NOTE, 'merger', 'budget']
const hostileErrors = (): Error[] => {
  const inMessage = new Error(`draft failed for ${NAME} <${EMAIL}> key ${TOKEN}: ${NOTE}`)
  const inCause = new Error('send failed', { cause: new Error(`${NAME} ${EMAIL} ${TOKEN} ${NOTE}`) })
  const inName = Object.assign(new Error('x'), { name: 'PriyaVenkataramanError' })
  const inStack = new TypeError('y')
  inStack.stack = `TypeError: y\n    at ${NAME.replace(' ', '')} (/srv/dazl/web/.next/server/chunks/1.js:10:5)\n    at notes (https://dazl.ai/notes/${encodeURIComponent(NOTE)}/a.js:1:2)\n    at ${TOKEN} (/home/${'priya'}/${TOKEN}.js:3:4)\n    at /srv/dazl/web/.next/server/app/page.js:7:9`
  return [inMessage, inCause, inName, inStack]
}

test('an arbitrary name, an email, a token-like string and a lead note never reach Sentry or the alert webhook', async () => {
  const bodies: string[] = []
  const f = (async (_u: string, init: RequestInit) => { bodies.push(String(init.body)); return new Response('{}') }) as unknown as typeof fetch
  const dep = { environment: 'staging', release: 'abc1234' }
  const sentry = makeSentryHook({ dsn: DSN, fetchImpl: f, deployment: dep })
  const webhook = makeAlertHook({ url: 'https://hooks.example.test/x', fetchImpl: f, deployment: dep })
  for (const [i, e] of hostileErrors().entries()) {
    const r = toRecord(e, { source: 'route', where: `/api/outreach/[id]`, method: 'POST', tenantId: TA })
    // a distinct fingerprint each, so the throttle sends every one
    sentry({ ...r, fingerprint: `f${i}` }); webhook({ ...r, fingerprint: `f${i}` })
  }
  await tick()
  assert.equal(bodies.length, 8)
  for (const b of bodies) {
    for (const leak of SENSITIVE) assert.ok(!b.toLowerCase().includes(leak.toLowerCase()), `${leak} reached an outgoing body: ${b.slice(0, 300)}`)
    assert.ok(!b.includes(TA), 'no tenant id')
  }
  // what does go: the type (an unknown class name becomes Error), the route and the code frames
  const ev = parse(bodies[0])[2]
  assert.deepEqual([ev.environment, ev.release, ev.transaction, ev.exception.values[0].type], ['staging', 'abc1234', '/api/outreach/[id]', 'Error'])
  const stackEv = bodies.map(b => b.includes('x-sentry') ? null : b).filter(Boolean)
  assert.ok(stackEv.length > 0)
  const fromStack = parse(bodies.find(b => b.includes('"type":"TypeError"'))!)[2]
  assert.deepEqual(fromStack.exception.values[0].stacktrace.frames.map((x: { filename: string }) => x.filename), ['/srv/dazl/web/.next/server/app/page.js', '/srv/dazl/web/.next/server/chunks/1.js'], 'only code paths, no function names')
})

test('frames: code paths and /_next/static/ bundle URLs only, no query, no function names', () => {
  assert.deepEqual(outboundFrames([
    'at handler (/srv/dazl/web/.next/server/app/api/leads/route.js:12:34)',
    'at async Promise.all (index 0)',
    'at node:internal/process/task_queues:105:5',
    'at u (https://dazl.ai/_next/static/chunks/app/page-1a2b.js?v=jane@example.com:1:999)',
    'at x (https://evil.example/priya/notes.js:1:1)',
    'at y (/home/priya/../etc/passwd:1:1)',
    'free text that is not a frame',
  ]), [
    { filename: '/srv/dazl/web/.next/server/app/api/leads/route.js', lineno: 12, colno: 34 },
    { filename: 'node:internal/process/task_queues', lineno: 105, colno: 5 },
    { filename: '/_next/static/chunks/app/page-1a2b.js', lineno: 1, colno: 999 },
  ])
})

test('environment: SENTRY_ENVIRONMENT when it is a plain word, else staging or production from DAZL_ENV; release only as a commit sha', () => {
  assert.deepEqual(deployment({}), { environment: 'production' })
  assert.deepEqual(deployment({ DAZL_ENV: 'staging' }), { environment: 'staging' })
  assert.deepEqual(deployment({ SENTRY_ENVIRONMENT: 'production', DAZL_ENV: 'staging' }), { environment: 'production' })
  assert.deepEqual(deployment({ SENTRY_ENVIRONMENT: 'jane@example.com', DAZL_COMMIT_SHA: 'abc1234' }), { environment: 'production', release: 'abc1234' })
  assert.deepEqual(deployment({ DAZL_COMMIT_SHA: 'not a sha' }), { environment: 'production' })
})

test('every error class in lib/ and app/ is on the allowlist of error types (add new ones to APP_ERROR_CLASSES)', () => {
  const found = new Set<string>()
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = path.join(dir, f)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.tsx?$/.test(f)) for (const m of readFileSync(p, 'utf8').matchAll(/class ([A-Za-z0-9_]+) extends [A-Za-z0-9_]*(?:Error|Exception)\b/g)) found.add(m[1])
    }
  }
  for (const d of ['../lib/', '../app/']) walk(new URL(d, import.meta.url).pathname)
  assert.deepEqual([...found].filter(n => !APP_ERROR_CLASSES.has(n)), [])
})
