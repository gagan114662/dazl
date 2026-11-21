// #1088 (review follow-up B, Hermes 2026-11-14): production sent no alert and said nothing about it. When OPS_ALERT_WEBHOOK_URL
// (or SENTRY_DSN) is set but unusable, the app's alert hook silently became a no-op; when the destination refused a send (4xx/5xx)
// or the send failed, that was swallowed too. Either way an operator reading the prod journal could not tell that alerts were not
// arriving. Now each says so in one plain JSON line on stderr - never through captureError (no loop), and never with the URL,
// the bot token or the DSN in it. The first two cases go through captureError with the destination read from the environment,
// exactly as the server builds its hooks; the delivery cases use the production hook with only the network replaced.
import test from 'node:test'
import assert from 'node:assert/strict'
import { captureError, makeAlertHook, makeSentryHook, toRecord } from '../lib/ops/errors.ts'

const TOKEN = '7012345678:AAHsecretTOKENvalue'
function stderrLines(run: () => void | Promise<void>): Promise<string[]> {
  const lines: string[] = [], orig = process.stderr.write
  process.stderr.write = ((s: string) => { lines.push(...String(s).split('\n').filter(Boolean)); return true }) as typeof process.stderr.write
  return Promise.resolve().then(run).finally(() => { process.stderr.write = orig }).then(() => lines)
}
const tick = () => new Promise(r => setTimeout(r, 20))
const withEnv = async (vars: Record<string, string | undefined>, run: () => Promise<void>) => {
  const before = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]))
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  try { await run() } finally { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
}
const parsed = (lines: string[]) => lines.map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
const rec = (where: string) => toRecord(new Error('boom'), { source: 'route', where })

test('#1088: a set but unusable alert URL (a Telegram URL with no chat_id, as operators paste it) is said once, without the token', async () => {
  await withEnv({ OPS_ALERT_WEBHOOK_URL: `https://api.telegram.org/bot${TOKEN}/sendMessage`, SENTRY_DSN: undefined }, async () => {
    const lines = await stderrLines(async () => { captureError(new Error('first'), { source: 'route', where: '/api/a' }); captureError(new Error('second'), { source: 'route', where: '/api/b' }); await tick() })
    const notes = parsed(lines).filter(x => x.type === 'alert_destination')
    assert.equal(notes.length, 1, lines.join('\n'))
    assert.equal(notes[0].level, 'warn'); assert.equal(notes[0].sink, 'alert'); assert.equal(notes[0].ok, false)
    assert.match(notes[0].problem, /chat_id/)
    for (const l of lines) { assert.ok(!l.includes(TOKEN) && !l.includes('api.telegram.org/bot'), l) }
  })
})

test('#1088: a set but unparsable SENTRY_DSN is said once, without the DSN', async () => {
  await withEnv({ OPS_ALERT_WEBHOOK_URL: undefined, SENTRY_DSN: 'https://keyonly@sentry.example.test/not-a-project' }, async () => {
    const lines = await stderrLines(async () => { captureError(new Error('x'), { source: 'route', where: '/api/c' }); await tick() })
    const notes = parsed(lines).filter(x => x.type === 'alert_destination')
    assert.equal(notes.length, 1, lines.join('\n')); assert.equal(notes[0].sink, 'sentry')
    for (const l of lines) assert.ok(!l.includes('keyonly'), l)
  })
})

test('#1088: a destination that refuses a send (HTTP 4xx/5xx) or cannot be reached is said, with the status only', async () => {
  const url = `https://api.telegram.org/bot${TOKEN}/sendMessage?chat_id=8444910202`
  for (const [answer, expect] of [[400, { status: 400 }], [503, { status: 503 }], ['throw', { reason: 'network' }], ['timeout', { reason: 'timeout' }]] as const) {
    const f = (async () => {
      if (answer === 'throw') throw new TypeError(`fetch failed for ${url}`)
      if (answer === 'timeout') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
      return new Response('{"ok":false}', { status: answer })
    }) as unknown as typeof fetch
    const lines = await stderrLines(async () => { makeAlertHook({ url, fetchImpl: f })(rec('/api/d')); await tick() })
    const notes = parsed(lines).filter(x => x.type === 'alert_delivery')
    assert.equal(notes.length, 1, `${answer}: ${lines.join('\n')}`)
    assert.equal(notes[0].sink, 'alert'); assert.equal(notes[0].ok, false)
    for (const [k, v] of Object.entries(expect)) assert.equal(notes[0][k], v, `${answer} ${k}`)
    for (const l of lines) assert.ok(!l.includes(TOKEN) && !l.includes('8444910202'), l)
  }
  // Sentry the same way
  const dsn = 'https://abc123@o1.ingest.sentry.example.test/42'
  const lines = await stderrLines(async () => { makeSentryHook({ dsn, fetchImpl: (async () => new Response('', { status: 429 })) as unknown as typeof fetch })(rec('/api/e')); await tick() })
  const notes = parsed(lines).filter(x => x.type === 'alert_delivery')
  assert.equal(notes.length, 1); assert.equal(notes[0].sink, 'sentry'); assert.equal(notes[0].status, 429)
  for (const l of lines) assert.ok(!l.includes('abc123'), l)
})

test('#1088 control: a delivered alert and an unset destination stay quiet (no extra line)', async () => {
  const ok = (async () => new Response('{"ok":true}', { status: 200 })) as unknown as typeof fetch
  const sent = await stderrLines(async () => { makeAlertHook({ url: 'https://hooks.example.test/x', fetchImpl: ok })(rec('/api/f')); await tick() })
  assert.deepEqual(parsed(sent).filter(x => x.type === 'alert_delivery' || x.type === 'alert_destination'), [])
  await withEnv({ OPS_ALERT_WEBHOOK_URL: undefined, SENTRY_DSN: undefined }, async () => {
    const lines = await stderrLines(async () => { captureError(new Error('y'), { source: 'route', where: '/api/g' }); await tick() })
    assert.deepEqual(parsed(lines).filter(x => x.type === 'alert_destination'), [])
  })
})

test('#1088: a dead destination is said at most once per throttled send, so an error loop cannot flood the journal (council review at 717214c)', async () => {
  const dead = (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
  const distinct = await stderrLines(async () => { const h = makeAlertHook({ url: 'https://hooks.example.test/x', fetchImpl: dead, maxPerWindow: 5 }); for (let i = 0; i < 100; i++) h(rec(`/api/loop-${i}`)); await tick() })
  assert.equal(parsed(distinct).filter(x => x.type === 'alert_delivery').length, 5)
  const same = await stderrLines(async () => { const h = makeAlertHook({ url: 'https://hooks.example.test/x', fetchImpl: dead }); for (let i = 0; i < 100; i++) h(rec('/api/same')); await tick() })
  assert.equal(parsed(same).filter(x => x.type === 'alert_delivery').length, 1)
})

test('#1088 control: a valid alert URL and DSN read from the environment are not reported as unusable', async () => {
  await withEnv({ OPS_ALERT_WEBHOOK_URL: 'https://hooks.example.test/x', SENTRY_DSN: 'https://abc123@o1.ingest.sentry.example.test/42' }, async () => {
    const lines = await stderrLines(async () => { captureError(new Error('z'), { source: 'route', where: '/api/h' }) })
    assert.deepEqual(parsed(lines).filter(x => x.type === 'alert_destination'), [])
  })
})
