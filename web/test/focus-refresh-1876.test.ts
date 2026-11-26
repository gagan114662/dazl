// #1876: one window focus on /app fired the same Home reads four times: two panels each attached their own `focus` and
// `visibilitychange` listener, and both call the shared readiness reader. One shared, debounced listener now fans out a
// single refresh per focus, and the reader shares its in-flight read, so each Home request goes out once.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

type Handler = () => void
const fake = () => {
  const listeners = new Map<string, Handler[]>()
  const target = () => ({
    addEventListener: (t: string, fn: Handler) => { listeners.set(t, [...(listeners.get(t) ?? []), fn]) },
    removeEventListener: (t: string, fn: Handler) => { listeners.set(t, (listeners.get(t) ?? []).filter(h => h !== fn)) },
  })
  const timers: (() => void)[] = []
  return {
    window: target(),
    document: { ...target(), hidden: false },
    listeners,
    fire: (t: string) => { for (const h of [...(listeners.get(t) ?? [])]) h() },
    count: (t: string) => (listeners.get(t) ?? []).length,
    timers,
    setTimeout: (fn: () => void) => { timers.push(fn); return timers.length },
    clearTimeout: (h: unknown) => { const i = Number(h) - 1; if (i >= 0) timers[i] = () => {} },
    runTimers: () => { const t = timers.splice(0); for (const f of t) f() },
  }
}
const src = (p: string) => readFileSync(new URL(`../app/app/${p}`, import.meta.url), 'utf8')

test('#1876 one focus event refreshes once, however many panels subscribe', async () => {
  const { subscribeFocusRefresh } = await import('../lib/focus-refresh.ts')
  const f = fake()
  const calls: string[] = []
  const offA = subscribeFocusRefresh(() => calls.push('ready-card'), f)
  const offB = subscribeFocusRefresh(() => calls.push('readiness'), f)
  assert.equal(f.count('focus'), 1, 'one focus listener for the page, not one per panel')
  assert.equal(f.count('visibilitychange'), 1, 'one visibility listener for the page')
  f.fire('focus')
  f.runTimers()
  assert.deepEqual(calls, ['ready-card', 'readiness'], 'each panel refreshed once')
  offA(); offB()
})

test('#1876 a focus and the visibilitychange it brings are one refresh, and a hidden tab refreshes none', async () => {
  const { subscribeFocusRefresh } = await import('../lib/focus-refresh.ts')
  const f = fake()
  let n = 0
  const off = subscribeFocusRefresh(() => { n++ }, f)
  f.fire('focus'); f.fire('visibilitychange'); f.runTimers()
  assert.equal(n, 1, 'the pair that one focus produces is debounced into one refresh')
  f.document.hidden = true
  f.fire('focus'); f.fire('visibilitychange'); f.runTimers()
  assert.equal(n, 1, 'a hidden tab does not refresh')
  f.document.hidden = false
  f.fire('focus'); f.runTimers()
  assert.equal(n, 2, 'the next focus refreshes again')
  off()
})

test('#1876 the listener is removed when the last panel leaves, and added back when one returns', async () => {
  const { subscribeFocusRefresh } = await import('../lib/focus-refresh.ts')
  const f = fake()
  const off = subscribeFocusRefresh(() => {}, f)
  assert.equal(f.count('focus'), 1)
  off()
  assert.equal(f.count('focus'), 0, 'no listener is left behind')
  assert.equal(f.count('visibilitychange'), 0)
  const off2 = subscribeFocusRefresh(() => {}, f)
  assert.equal(f.count('focus'), 1, 'a later page reuses the same shared listener')
  off2()
})

test('#1876 the two Home panels use the shared refresh, not their own focus listeners', () => {
  for (const p of ['ready-card.tsx', 'readiness.tsx']) {
    const s = src(p)
    assert.match(s, /import \{ subscribeFocusRefresh \} from '@\/lib\/focus-refresh'/, p)
    assert.doesNotMatch(s, /addEventListener\('focus'/, `${p} attaches its own focus listener`)
    assert.doesNotMatch(s, /addEventListener\('visibilitychange'/, `${p} attaches its own visibility listener`)
  }
})

test('#1876 concurrent readers share one in-flight read, so a shared refresh asks each endpoint once; a later read is fresh', async () => {
  const { loadReadinessInput } = await import('../app/app/readiness-input.ts')
  const realFetch = globalThis.fetch
  const hits: Record<string, number> = {}
  let release: (() => void) | null = null
  const gate = new Promise<void>(r => { release = r })
  globalThis.fetch = (async (u: string) => {
    hits[String(u)] = (hits[String(u)] ?? 0) + 1
    await gate
    return new Response(JSON.stringify({}), { status: 200 })
  }) as unknown as typeof fetch
  try {
    const a = loadReadinessInput()
    const b = loadReadinessInput()
    release!()
    await Promise.all([a, b])
    const urls = Object.keys(hits)
    assert.equal(urls.length, 9, `nine endpoints read: ${urls.join(', ')}`)
    for (const u of urls) assert.equal(hits[u], 1, `${u} was read ${hits[u]} times by one shared refresh`)
    await loadReadinessInput()
    for (const u of urls) assert.equal(hits[u], 2, `${u} is read again on a later refresh, never served stale`)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('#1876/#1880 a save during an in-flight read starts a new read, and the new result wins', async () => {
  const { loadReadinessInput } = await import('../app/app/readiness-input.ts')
  const realFetch = globalThis.fetch
  const hits: Record<string, number> = {}
  let releaseOld: (() => void) | null = null
  const oldGate = new Promise<void>(r => { releaseOld = r })
  globalThis.fetch = (async (u: string) => {
    hits[String(u)] = (hits[String(u)] ?? 0) + 1
    if (hits[String(u)] === 1) { await oldGate; return new Response(JSON.stringify({ business_name: 'before the save' }), { status: 200 }) }
    return new Response(JSON.stringify({ business_name: 'after the save' }), { status: 200 })
  }) as unknown as typeof fetch
  try {
    const mount = loadReadinessInput()                    // the shared mount read, still in flight
    const afterSave = loadReadinessInput({ fresh: 1 }) // the profile save: a NEW read, never the one in flight
    releaseOld!()
    const [old, next] = await Promise.all([mount, afterSave])
    assert.equal(hits['/api/settings/profile'], 2, 'the save started a second profile read instead of joining the in-flight one')
    assert.equal((next.input.profile as { business_name?: string }).business_name, 'after the save', 'the new read is the one that wins')
    assert.equal((old.input.profile as { business_name?: string }).business_name, 'before the save', 'fixture: the in-flight read was the older one')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('#1876/#1880 one focus is one read per endpoint, with both panels subscribing', async () => {
  const { subscribeFocusRefresh } = await import('../lib/focus-refresh.ts')
  const { loadReadinessInput } = await import('../app/app/readiness-input.ts')
  const f = fake()
  const realFetch = globalThis.fetch
  const hits: Record<string, number> = {}
  globalThis.fetch = (async (u: string) => {
    hits[String(u)] = (hits[String(u)] ?? 0) + 1
    await new Promise(r => setTimeout(r, 1))
    return new Response(JSON.stringify({}), { status: 200 })
  }) as unknown as typeof fetch
  const read = (epoch: number) => { void loadReadinessInput({ fresh: epoch }) }
  const offA = subscribeFocusRefresh(read, f)
  const offB = subscribeFocusRefresh(read, f)
  try {
    f.fire('focus'); f.fire('visibilitychange'); f.runTimers()
    await new Promise(r => setTimeout(r, 60))
    const urls = Object.keys(hits)
    assert.equal(urls.length, 9, `nine endpoints read: ${urls.join(', ')}`)
    for (const u of urls) assert.equal(hits[u], 1, `${u} was read ${hits[u]} times for one focus`)
  } finally {
    offA(); offB(); globalThis.fetch = realFetch
  }
})

test('#1876/#1880 one save is one read per endpoint, with both panels subscribing', async () => {
  const { subscribeFocusRefresh } = await import('../lib/focus-refresh.ts')
  const { loadReadinessInput } = await import('../app/app/readiness-input.ts')
  const f = fake()
  const realFetch = globalThis.fetch
  const hits: Record<string, number> = {}
  globalThis.fetch = (async (u: string) => {
    hits[String(u)] = (hits[String(u)] ?? 0) + 1
    await new Promise(r => setTimeout(r, 1))
    return new Response(JSON.stringify({}), { status: 200 })
  }) as unknown as typeof fetch
  const read = (epoch: number) => { void loadReadinessInput({ fresh: epoch }) }
  const offA = subscribeFocusRefresh(read, f)
  const offB = subscribeFocusRefresh(read, f)
  try {
    f.fire('profile-updated'); f.runTimers()
    await new Promise(r => setTimeout(r, 60))
    for (const [u, n] of Object.entries(hits)) assert.equal(n, 1, `${u} was read ${n} times for one save`)
    assert.equal(Object.keys(hits).length, 9)
  } finally {
    offA(); offB(); globalThis.fetch = realFetch
  }
})
