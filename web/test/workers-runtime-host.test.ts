// runHost's idle and error-backoff sleeps (lib/workers/runtime.ts, #918): every sleep removes its abort listener
// whether its timer fires or the signal aborts, so a long idle host holds at most one listener per ticker; abort ends
// idle and backoff sleeps promptly; tick errors are still captured; concurrency stays bounded. Pure host loop: the
// fake host's tick never touches a database, worker or network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { abortableSleep, runHost } from '../lib/workers/runtime.ts'
import { setErrorSinks, type ErrorRecord } from '../lib/ops/errors.ts'

const listeners = (s: AbortSignal) => getEventListeners(s, 'abort').length

test('idle host: abort listeners stay bounded by concurrency, not by completed ticks', async () => {
  for (const concurrency of [1, 3]) {
    const ac = new AbortController()
    let ticks = 0, maxSeen = 0
    const host = {
      async tick() {
        ticks++
        maxSeen = Math.max(maxSeen, listeners(ac.signal))
        if (ticks >= 40 * concurrency) ac.abort()
        return null
      },
    }
    await runHost(host, { concurrency, idleMs: 1, signal: ac.signal })
    assert.ok(ticks >= 40 * concurrency, `ran ${ticks} ticks`)
    assert.ok(maxSeen <= concurrency, `listeners peaked at ${maxSeen} with concurrency ${concurrency}`)
    assert.equal(listeners(ac.signal), 0, 'no listener left after shutdown')
  }
})

test('error backoff: tick errors are captured, backoff sleeps release their listeners', async () => {
  const seen: ErrorRecord[] = []
  const restore = setErrorSinks([r => { seen.push(r) }])
  try {
    const ac = new AbortController()
    let ticks = 0, maxSeen = 0
    const host = {
      async tick(): Promise<null> {
        ticks++
        maxSeen = Math.max(maxSeen, listeners(ac.signal))
        if (ticks >= 30) ac.abort()
        throw new Error('db fault')
      },
    }
    await runHost(host, { concurrency: 1, idleMs: 1, signal: ac.signal })
    assert.equal(seen.length, ticks, 'every escaped tick error is captured')
    assert.ok(seen.every(r => r.source === 'worker' && r.where === 'workers:host'))
    assert.ok(maxSeen <= 1, `listeners peaked at ${maxSeen}`)
    assert.equal(listeners(ac.signal), 0)
  } finally { restore() }
})

test('abort ends a long idle sleep promptly and leaves nothing behind', async () => {
  const ac = new AbortController()
  let ticks = 0
  const host = { async tick() { ticks++; return null } }
  const started = Date.now()
  const run = runHost(host, { concurrency: 2, idleMs: 60_000, signal: ac.signal })
  await new Promise(r => setTimeout(r, 20))
  assert.equal(listeners(ac.signal), 2, 'one listener per sleeping ticker')
  ac.abort()
  await run
  assert.ok(Date.now() - started < 2_000, 'shutdown did not wait for the idle timer')
  assert.equal(ticks, 2)
  assert.equal(listeners(ac.signal), 0)
})

test('concurrency is clamped to 1..16 tickers', async () => {
  for (const [asked, expected] of [[0, 1], [5, 5], [99, 16]] as const) {
    const ac = new AbortController()
    let active = 0, peak = 0
    const host = {
      async tick() {
        active++; peak = Math.max(peak, active)
        await new Promise(r => setTimeout(r, 5))
        active--
        ac.abort()
        return null
      },
    }
    await runHost(host, { concurrency: asked, idleMs: 1, signal: ac.signal })
    assert.equal(peak, expected, `concurrency ${asked}`)
  }
})

test('abortableSleep: already-aborted returns at once; normal timeout removes its listener', async () => {
  const pre = new AbortController(); pre.abort()
  const t0 = Date.now()
  await abortableSleep(60_000, pre.signal)
  assert.ok(Date.now() - t0 < 100)
  assert.equal(listeners(pre.signal), 0)

  const ac = new AbortController()
  for (let i = 0; i < 25; i++) await abortableSleep(1, ac.signal)
  assert.equal(listeners(ac.signal), 0, 'completed sleeps leave no listeners')
})
