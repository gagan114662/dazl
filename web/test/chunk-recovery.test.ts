import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { chunkRecoveryScript } from '../lib/chunk-recovery.ts'

// A fake browser tab: sessionStorage survives "reloads" (each mount() is a fresh page in the same tab, as in a
// browser); listeners, DOM and flags are per page. The code under test is the exact serialized <head> script.
class MemStorage { m = new Map<string, string>(); getItem(k: string) { return this.m.get(k) ?? null } setItem(k: string, v: string) { this.m.set(k, String(v)) } }
type L = (e: unknown) => void
function tab(opts: { storage?: () => unknown } = {}) {
  const storage = new MemStorage()
  const t = { storage, reloads: 0, path: '/app' }
  function mount(build = 'build-A') {
    const win: Record<string, L[]> = {}; const doc: Record<string, L[]> = {}; const alerts: string[] = []
    const el = (tag: string) => ({ tagName: tag.toUpperCase(), type: '', textContent: '', children: [] as unknown[], setAttribute() {}, addEventListener() {}, appendChild(c: unknown) { this.children.push(c) } })
    const body = { appendChild: (box: { children: { textContent: string }[] }) => { alerts.push(box.children.map(c => c.textContent).join(' | ')) } }
    const location = { get pathname() { return t.path }, reload: () => { t.reloads++ } }
    const window: Record<string, unknown> = {
      addEventListener: (n: string, f: L) => { (win[n] ??= []).push(f) },
      document: { body, createElement: el, addEventListener: (n: string, f: L) => { (doc[n] ??= []).push(f) } },
      location,
    }
    Object.defineProperty(window, 'sessionStorage', { get: opts.storage ?? (() => storage) })
    vm.runInNewContext(chunkRecoveryScript(build), { window, JSON, Date, String })
    const page = {
      alerts,
      scriptFails: (src = '/_next/static/chunks/0sp2f4p8jce6m.js?dpl=abc', extra: object = {}) => win.error.forEach(f => f({ target: { tagName: 'SCRIPT', src, ...extra } })),
      linkFails: (href: string, rel = 'stylesheet') => win.error.forEach(f => f({ target: { tagName: 'LINK', href, rel } })),
      rejects: (reason: unknown) => win.unhandledrejection.forEach(f => f({ reason })),
      throws: (error: unknown) => win.error.forEach(f => f({ target: window, error, message: String((error as Error)?.message ?? '') })),
      types: () => doc.input.forEach(f => f({})),
    }
    return page
  }
  return { t, mount }
}
const chunkErr = () => Object.assign(new Error('Loading chunk 42 failed.'), { name: 'ChunkLoadError' })

test("Instinct's repro: error -> one reload; same build after reload -> notice; 10 s and 1 h later -> still no second reload", () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  try {
    const { t, mount } = tab()
    mount().rejects(chunkErr())
    assert.equal(t.reloads, 1)
    const after = mount() // the reload brought back the same build and the chunk is still missing
    after.rejects(chunkErr())
    assert.equal(t.reloads, 1)
    assert.deepEqual(after.alerts, ['dazl was updated | Part of this page could not load. Copy anything you typed, then reload to get the current version. | Reload'])
    mock.timers.tick(10_000); after.rejects(chunkErr())
    mock.timers.tick(60 * 60_000); const later = mount(); later.scriptFails()
    assert.equal(t.reloads, 1, 'never more than one automatic reload per build')
    assert.equal(after.alerts.length, 1, 'one notice per page, not a stack')
    assert.equal(later.alerts.length, 1)
  } finally { mock.timers.reset() }
})

test('client-side navigation cannot earn another reload on the same build; the failing path is read at error time', () => {
  const { t, mount } = tab()
  const p = mount()
  t.path = '/app/outreach' // the root layout's listener survives client-side routing
  p.rejects(chunkErr())
  assert.equal(JSON.parse(t.storage.getItem('dazl-chunk-reload:build-A')!).path, '/app/outreach')
  t.path = '/app/leads'
  const q = mount(); q.rejects(chunkErr())
  assert.equal(t.reloads, 1)
  assert.equal(q.alerts.length, 1)
})

test('a failed page script (non-bubbling resource error, before hydration) triggers the same bounded recovery', () => {
  const { t, mount } = tab()
  mount().scriptFails()
  mount().scriptFails()
  mount().linkFails('/_next/static/chunks/2ztfs7h2ad0az.css')
  assert.equal(t.reloads, 1)
})

test('other resources do not trigger anything: off-build scripts, prefetches, fonts, ordinary errors', () => {
  const { t, mount } = tab()
  const p = mount()
  p.scriptFails('https://cdn.example/x.js')
  p.linkFails('/_next/static/chunks/abc.js', 'prefetch')
  p.linkFails('/_next/static/media/font.woff2', 'preload')
  p.throws(new TypeError('x is undefined'))
  p.rejects(undefined)
  assert.equal(t.reloads, 0)
  assert.equal(p.alerts.length, 0)
})

test('a new deploy gets its own single reload', () => {
  const { t, mount } = tab()
  mount('build-A').rejects(chunkErr())
  mount('build-B').rejects(chunkErr())
  const p = mount('build-B'); p.rejects(chunkErr())
  assert.equal(t.reloads, 2)
  assert.equal(p.alerts.length, 1)
})

test('sessionStorage missing, throwing, failing to write or silently dropping writes: notice, never a reload', () => {
  for (const storage of [
    () => null,
    () => { throw new Error('SecurityError') },
    () => ({ getItem: () => null, setItem: () => { throw new Error('QuotaExceededError') } }),
    () => ({ getItem: () => null, setItem: () => {} }),
  ]) {
    const { t, mount } = tab({ storage })
    for (let i = 0; i < 3; i++) { const p = mount(); p.rejects(chunkErr()); assert.equal(p.alerts.length, 1) }
    assert.equal(t.reloads, 0)
  }
})

test('typing on the page blocks the automatic reload, so unsaved text is never discarded', () => {
  const { t, mount } = tab()
  const p = mount(); p.types(); p.rejects(chunkErr())
  assert.equal(t.reloads, 0)
  assert.equal(p.alerts.length, 1)
  assert.equal(t.storage.getItem('dazl-chunk-reload:build-A'), null, 'the one reload stays available')
})

test('the shipped script is self-contained', () => {
  assert.doesNotThrow(() => new Function(chunkRecoveryScript('x').replace(/\(window, "x"\);$/, '')))
  assert.ok(!/\brequire\(|\bimport\b/.test(chunkRecoveryScript('x')))
})

test('isChunkLoadError (error boundaries) recognises chunk failures only', async () => {
  const { isChunkLoadError } = await import('../lib/chunk-recovery.ts')
  assert.equal(isChunkLoadError(Object.assign(new Error('Failed to load chunk /_next/static/chunks/a.js from module 1'), { name: 'ChunkLoadError' })), true)
  assert.equal(isChunkLoadError(new Error('Loading CSS chunk 3 failed')), true)
  assert.equal(isChunkLoadError(new TypeError('x is undefined')), false)
  assert.equal(isChunkLoadError(null), false)
  assert.equal(isChunkLoadError('Loading chunk 7 failed.'), true)
})
