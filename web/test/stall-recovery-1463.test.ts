import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { stallWatchScript, STALL_MS, RELOAD_WINDOW_MS, OPENING_ID } from '../lib/stall-recovery.ts'

// #1463: the exact serialized script from the "Opening your workspace…" fallback, in a fake tab whose sessionStorage
// survives reloads (each mount is a fresh page in the same tab).
class Mem { m = new Map<string, string>(); getItem(k: string) { return this.m.get(k) ?? null } setItem(k: string, v: string) { this.m.set(k, String(v)) } }
function tab() {
  const storage = new Mem(); const t = { reloads: 0 }
  const mount = (stuck: boolean) => {
    const el = { children: [] as unknown[], attrs: {} as Record<string, string>, appendChild(c: unknown) { this.children.push(c) }, setAttribute(k: string, v: string) { this.attrs[k] = v } }
    let present = true
    const node = () => ({ type: '', textContent: '', children: [] as unknown[], setAttribute() {}, addEventListener() {}, appendChild(c: unknown) { this.children.push(c) } })
    const window = { setTimeout, sessionStorage: storage, location: { reload: () => { t.reloads++ } },
      document: { getElementById: (id: string) => (id === OPENING_ID && present ? el : null), createElement: node } }
    vm.runInNewContext(stallWatchScript(), { window, Date, Number, String, JSON })
    if (!stuck) present = false // the streamed page replaced the fallback
    return el
  }
  return { t, mount }
}

test('a stuck fallback reloads once; a second stall within the window shows a Reload button, never a loop', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  try {
    const { t, mount } = tab()
    mount(true); mock.timers.tick(STALL_MS - 1); assert.equal(t.reloads, 0)
    mock.timers.tick(1); assert.equal(t.reloads, 1)
    const el = mount(true); mock.timers.tick(STALL_MS); assert.equal(t.reloads, 1)
    assert.equal(el.attrs['data-stalled'], '1'); assert.equal(el.children.length, 1)
    mock.timers.tick(RELOAD_WINDOW_MS); mount(true); mock.timers.tick(STALL_MS); assert.equal(t.reloads, 2, 'a later stall may reload again')
  } finally { mock.timers.reset() }
})

test('a page that loaded does nothing', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  try { const { t, mount } = tab(); const el = mount(false); mock.timers.tick(STALL_MS * 3); assert.equal(t.reloads, 0); assert.equal(el.children.length, 0) }
  finally { mock.timers.reset() }
})

test('the /app layout fallback carries the watch and its id', () => {
  const src = readFileSync(new URL('../app/app/layout.tsx', import.meta.url), 'utf8')
  const fb = src.slice(src.indexOf('<Suspense fallback={'), src.indexOf('<AuthGate>'))
  assert.match(fb, /id=\{OPENING_ID\}/); assert.match(fb, /stallWatchScript\(\)/); assert.match(fb, /Opening your workspace/)
})
