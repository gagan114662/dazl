import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { stallWatchScript, STALL_MS, OPENING_ID } from '../lib/stall-recovery.ts'

// #1463: a tab that is not visible is given no animation frames. React's streamed-page script reveals the first Suspense boundary
// in requestAnimationFrame (and retries its hydration the same way), so in a hidden tab the /app page that has fully arrived stays
// behind "Opening your workspace…" with no data request, and the stall watch reloads and then blames a healthy server
// (browser proof: test/smoke/hidden-tab.smoke.mjs). The inline script in the fallback runs before the page streams in: while the
// tab is hidden it runs frame callbacks from a timer instead. This is the exact serialized script, in a fake tab.
function tab(visibility: 'hidden' | 'visible') {
  const t = { reloads: 0, frames: [] as ((n: number) => void)[], cancelled: [] as number[], visibility, present: true }
  const el = { children: [] as unknown[], attrs: {} as Record<string, string>, appendChild(c: unknown) { this.children.push(c) }, setAttribute(k: string, v: string) { this.attrs[k] = v } }
  const node = () => ({ type: '', textContent: '', setAttribute() {}, addEventListener() {}, appendChild() {} })
  const window = {
    setTimeout, clearTimeout, performance: { now: () => 7 },
    sessionStorage: { m: new Map<string, string>(), getItem(k: string) { return this.m.get(k) ?? null }, setItem(k: string, v: string) { this.m.set(k, v) } },
    location: { reload: () => { t.reloads++ } },
    // the browser's own: in a hidden tab the callback is kept and never run
    requestAnimationFrame: (cb: (n: number) => void) => { t.frames.push(cb); return 100 + t.frames.length },
    cancelAnimationFrame: (id: number) => { t.cancelled.push(id) },
    document: { get visibilityState() { return t.visibility }, getElementById: (id: string) => (id === OPENING_ID && t.present ? el : null), createElement: node },
  }
  vm.runInNewContext(stallWatchScript(), { window, Date, Number, String, JSON })
  return { t, window, el }
}

test('#1463 hidden tab: a frame callback runs from a timer, so the streamed page is revealed without the tab being looked at', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  try {
    const { t, window, el } = tab('hidden')
    const ran: number[] = []
    // what React's streamed script does when the page arrives: reveal in a frame; the reveal removes the fallback
    window.requestAnimationFrame(n => { ran.push(n); t.present = false })
    assert.deepEqual(ran, [], 'never synchronously')
    mock.timers.tick(50)
    assert.deepEqual(ran, [7], 'the callback ran, with a timestamp, although the browser gave no frame')
    assert.equal(t.frames.length, 0, 'not left with the browser, which would hold it until the tab is shown')
    mock.timers.tick(STALL_MS * 3)
    assert.equal(t.reloads, 0, 'no reload: the page opened')
    assert.equal(el.children.length, 0, 'no "This is taking too long" notice')
  } finally { mock.timers.reset() }
})

test('#1463 hidden tab: a cancelled frame callback never runs', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  try {
    const { t, window } = tab('hidden')
    let ran = 0
    const id = window.requestAnimationFrame(() => { ran++ })
    window.cancelAnimationFrame(id)
    mock.timers.tick(1000)
    assert.equal(ran, 0)
    assert.deepEqual(t.cancelled, [], 'the id was ours, not the browser\'s')
  } finally { mock.timers.reset() }
})

test('#1463 visible tab: frames are the browser\'s own, untouched', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  try {
    const { t, window } = tab('visible')
    let ran = 0
    const cb = () => { ran++ }
    const id = window.requestAnimationFrame(cb)
    assert.equal(id, 101, 'the browser\'s id is returned')
    assert.deepEqual(t.frames, [cb], 'the callback went to the browser as it was')
    mock.timers.tick(1000)
    assert.equal(ran, 0, 'no timer runs it')
    window.cancelAnimationFrame(id)
    assert.deepEqual(t.cancelled, [101], 'cancelling goes to the browser')
    // the tab is hidden later: from then on callbacks run from a timer
    t.visibility = 'hidden'
    window.requestAnimationFrame(cb); mock.timers.tick(50)
    assert.equal(ran, 1)
  } finally { mock.timers.reset() }
})
