// Exercise the actual client components with deterministic hook, fetch and clock fixtures.
// No browser session, network, credentials or provider is involved.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

type Props = { children?: unknown; onClick?: () => void; value?: string }
type Element = { tag: unknown; props: Props }
type FixtureResponse = { ok: boolean; status: number; json: () => Promise<unknown> }
type Pending = { path: string; method: string; body?: string; resolve: (r: FixtureResponse) => void }
const placed = (tag: unknown, props: Props): Element => ({ tag, props })
function find(node: unknown, match: (node: Element) => boolean): Element | undefined {
  if (Array.isArray(node)) return node.map(item => find(item, match)).find(Boolean)
  if (!node || typeof node !== 'object' || !('props' in node)) return
  const item = node as Element
  return match(item) ? item : find(item.props.children, match)
}
function words(node: unknown): string {
  if (Array.isArray(node)) return node.map(words).join(' ')
  if (typeof node === 'string') return node
  return node && typeof node === 'object' && 'props' in node ? words((node as Element).props.children) : ''
}

function fixture(path: string) {
  let renderPhase = false
  let clock = 100_000
  let index = 0
  let writes = 0
  let first = true
  const state: unknown[] = []
  const effects: (() => void | (() => void))[] = []
  const pending: Pending[] = []
  class FixtureDate extends Date {
    static now() { assert.equal(renderPhase, false, 'clock must not be read during render'); return clock }
  }
  const hooks = {
    useState(value: unknown) {
      const n = index++
      if (first) state[n] = value
      return [state[n], (next: unknown) => { writes++; state[n] = next }]
    },
    useEffect(effect: () => void | (() => void)) { if (first) effects.push(effect) },
  }
  const sandboxModule = { exports: { default: () => null as unknown } }
  const source = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText
  runInNewContext(source, {
    exports: sandboxModule.exports,
    module: sandboxModule,
    require(name: string) {
      if (name === 'react') return hooks
      if (name === 'react/jsx-runtime') return { jsx: placed, jsxs: placed }
      return { default: () => null, followupAsk: () => null }
    },
    Date: FixtureDate,
    fetch(url: string, init?: { method: string; body?: string }) {
      return new Promise<FixtureResponse>(resolve => {
        pending.push({ path: url, method: init?.method ?? 'GET', body: init?.body, resolve })
      })
    },
  })
  const render = () => {
    index = 0
    renderPhase = true
    try { return sandboxModule.exports.default() } finally { renderPhase = false; first = false }
  }
  async function answer(path: string, method: string, json: unknown, status = 200) {
    const n = pending.findIndex(r => r.path === path && r.method === method)
    assert.notEqual(n, -1, `${method} ${path}`)
    const [request] = pending.splice(n, 1)
    request.resolve({ ok: status < 400, status, json: async () => json })
    await new Promise<void>(resolve => setImmediate(resolve))
    return request
  }
  return {
    render, answer, pending,
    mount() { render(); return effects.map(effect => effect()).filter(f => typeof f === 'function') },
    advance(milliseconds: number) { clock = milliseconds },
    stateWrites() { return writes },
  }
}

test('follow-up schedule uses the loaded clock and refreshes it on an existing user action, without polling', async () => {
  const view = fixture('../app/app/follow-ups/followups-client.tsx')
  view.mount()
  const warm = { thread_id: 'warm', company: 'Example', to_email: 'fixture@example.invalid', last_reply_at: 20, reply_excerpt: '', reopen: null }
  await view.answer('/api/outreach/reopen', 'GET', { warm: [warm], reopens: [] })
  await view.answer('/api/outreach/followups', 'GET', {
    enabled: true, account: null, hold: null, sent: [],
    threads: [{ ...warm, thread_id: 'due', next_due_at: 101, followups_sent: 0, stopped: null }],
  })
  const beforeDue = words(view.render())
  assert.match(beforeDue, /next one /)
  assert.doesNotMatch(beforeDue, /next one due now/)
  assert.equal(view.pending.length, 0, 'no polling or implicit send')
  view.advance(101_000)
  const draft = find(view.render(), node => node.tag === 'button' && words(node) === 'Draft re-open')
  assert.ok(draft?.props.onClick)
  draft.props.onClick()
  assert.match(words(view.render()), /next one due now/)
  const posted = await view.answer('/api/outreach/reopen', 'POST', { warm: [], reopens: [] })
  assert.deepEqual(JSON.parse(posted.body ?? '{}'), { action: 'draft', thread_id: 'warm' })
  assert.equal(view.pending.length, 0, 'draft refresh does not send')
})

test('cold-sequence mount is read-only and does not apply a completed request after cleanup', async () => {
  const path = '/api/outreach/sequences'
  const stale = fixture('../app/app/outreach/sequences-client.tsx')
  const cleanups = stale.mount()
  assert.deepEqual(stale.pending.map(r => [r.path, r.method]), [[path, 'GET']])
  cleanups.forEach(cleanup => cleanup())
  await stale.answer(path, 'GET', { sequences: [], test_addresses: ['stale@example.invalid'], campaigns: [], status: {} })
  assert.equal(stale.stateWrites(), 0, 'success after cleanup must not publish either state')
  const live = fixture('../app/app/outreach/sequences-client.tsx')
  live.mount()
  await live.answer(path, 'GET', { sequences: [], test_addresses: ['fixture@example.invalid'], campaigns: [], status: {} })
  assert.equal(find(live.render(), node => node.tag === 'textarea')?.props.value, 'fixture@example.invalid')
  assert.equal(live.pending.length, 0)
})
