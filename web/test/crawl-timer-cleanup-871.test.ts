// #871 regression (CI on 22ced314): a throwing or rejecting Get skipped the per-fetch race's
// clearTimeout/removeEventListener and the whole-crawl deadline cleanup, leaking the REFERENCED 45s budget
// timer - the find-contact child then outlived its original 60s spawn timeout. The fix is try/finally at both
// levels; this test tracks real setTimeout/clearTimeout (with hasRef) and the caller signal's listener
// balance so the leak class cannot return. No fake clock, no waiver, no raised timeout: an empty live-timer
// map after every exit path IS the natural-exit guarantee (a pending referenced timer pins the event loop).
import test from 'node:test'
import assert from 'node:assert/strict'
import { crawlSite } from '../lib/connectors/sitecrawl.ts'

function trackTimers() {
  const origSet = globalThis.setTimeout, origClear = globalThis.clearTimeout
  const live = new Map<NodeJS.Timeout, number>()
  globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    let h: NodeJS.Timeout
    h = origSet(() => { live.delete(h); fn(...args) }, ms as number)
    live.set(h, ms as number)
    return h
  }) as never
  globalThis.clearTimeout = ((h: NodeJS.Timeout) => { live.delete(h); return origClear(h) }) as never
  return {
    live,
    restore: () => { for (const h of live.keys()) origClear(h); globalThis.setTimeout = origSet; globalThis.clearTimeout = origClear },
  }
}

test('a throwing or rejecting Get leaves no budget timer and no caller-abort listener behind', async () => {
  const t = trackTimers()
  try {
    for (const [name, get] of [
      ['sync throw', () => { throw new Error('fixture throw') }],
      ['async reject', async () => { throw new Error('fixture reject') }],
    ] as const) {
      const ac = new AbortController()
      const added: unknown[] = [], removed: unknown[] = []
      const origAdd = ac.signal.addEventListener.bind(ac.signal), origRem = ac.signal.removeEventListener.bind(ac.signal)
      ac.signal.addEventListener = ((type: string, cb: unknown, opts: unknown) => { added.push(cb); return origAdd(type, cb as never, opts as never) }) as never
      ac.signal.removeEventListener = ((type: string, cb: unknown, opts: unknown) => { removed.push(cb); return origRem(type, cb as never, opts as never) }) as never
      const before = t.live.size
      await assert.rejects(
        crawlSite('timer-fixture.test', get as never, 0, undefined, false, ac.signal, undefined, undefined, 1000),
        /fixture/, `${name}: the Get's own failure propagates`,
      )
      assert.equal(t.live.size, before, `${name}: no live budget timer (a referenced survivor pins the event loop past exit)`)
      // polite's own abort listener is the only one registered on the caller signal (AbortSignal.any wires its
      // composite through internal slots, not the public addEventListener). The regression was that listener
      // surviving the throw, so the balance must be exactly zero.
      assert.equal(added.length, 1, `${name}: polite's abort listener was registered`)
      assert.deepEqual(removed, added, `${name}: every registered listener removed`)
    }
  } finally { t.restore() }
})

test('an aborted caller still cleans up timers and listeners when the crawl was interrupted mid-fetch', async () => {
  const t = trackTimers()
  try {
    const ac = new AbortController()
    const before = t.live.size
    const get = (_u: string, o?: { signal?: AbortSignal }) => new Promise<null>(resolve => {
      o?.signal?.addEventListener('abort', () => resolve(null), { once: true })
      ac.abort() // the caller aborts while the first fetch is in flight
    })
    const r = await crawlSite('abort-fixture.test', get as never, 0, undefined, false, ac.signal, undefined, undefined, 1000)
    assert.equal(r.stoppedBy, 'aborted')
    assert.equal(t.live.size, before, 'no live budget timer after an aborted crawl')
  } finally { t.restore() }
})
