// #719: a stale session's 403 reauth_required on Settings is answered by the "Confirm it is you" dialog. The panels
// must not also print the raw code "reauth_required" (Hermes-PC live check 2026-11-12, finding 1), and the dialog
// must not sit over the form that triggered it (finding 2: it was sticky top-2 and covered the Team card).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { panelError } from '../app/app/settings/panel-error.ts'

const src = (f: string) => readFileSync(fileURLToPath(new URL(`../app/app/settings/${f}`, import.meta.url)), 'utf8')
const PANELS = ['team-panel.tsx', 'plan-panel.tsx', 'crm-panel.tsx', 'enrichment-panel.tsx', 'advanced-panel.tsx']

test('#719 AC-1: a reauth_required answer prints nothing in the panel (the dialog asks)', () => {
  assert.equal(panelError('reauth_required', 'Something went wrong'), '')
  assert.equal(panelError('reauth_required', 'Something went wrong', { forbidden: 'Your role cannot do that.' }), '')
})

test('#719 AC-1: other answers keep their words', () => {
  assert.equal(panelError('forbidden', 'Something went wrong', { forbidden: 'Your role cannot do that.' }), 'Your role cannot do that.')
  assert.equal(panelError('No subscription found', 'Something went wrong'), 'No subscription found')
  assert.equal(panelError(undefined, 'Something went wrong'), 'Something went wrong')
})

for (const f of PANELS) {
  test(`#719 AC-1: ${f} routes its error text through panelError, never the raw j.error`, () => {
    const s = src(f)
    assert.match(s, /from '\.\/panel-error'/, `${f} imports panelError`)
    assert.ok(!/j\.error \|\||\?\? j\.error/.test(s), `${f} still falls back to the raw j.error code`)
  })
}

test('#719 AC-2: the Confirm-it-is-you dialog is in the page flow, not sticky over the form, and scrolls into view', () => {
  const s = src('reauth-gate.tsx')
  assert.ok(!/\bsticky\b/.test(s), 'the dialog must not be sticky (it covered the Team card)')
  assert.match(s, /scrollIntoView\(/, 'the dialog is brought into view when it opens')
})

// #719 F1 (Hermes-PC, bf3ffb8d): a repeated stale action with the same method must re-open/scroll the request.
test('#719 F1: every reauth_required answer asks again, including same-method repeats; wrong password stays refused; retry after confirm works', async () => {
  const { watchReauth } = await import('../app/app/settings/reauth-prompt.ts')
  let fresh = false
  let invites = 0
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const server = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = String(url)
    if (u === '/api/auth/reauth' && init?.method === 'POST') {
      const ok = JSON.parse(String(init.body)).password === 'right'
      if (ok) fresh = true
      return ok ? json(200, { ok: true }) : json(403, { error: 'Wrong password' })
    }
    if (u === '/api/auth/reauth') return json(200, { method: 'password' })
    if (u === '/api/team/invite') { invites++; return fresh ? json(200, { ok: true }) : json(403, { error: 'reauth_required' }) }
    return json(404, {})
  }
  const asks: Array<[string, number]> = []
  const w = watchReauth(server as typeof fetch, (m, seq) => asks.push([m, seq]))
  assert.equal((await w.fetch('/api/team/invite', { method: 'POST' })).status, 403)
  assert.equal((await w.fetch('/api/team/invite', { method: 'POST' })).status, 403) // user scrolled back and clicked again
  assert.deepEqual(asks, [['password', 1], ['password', 2]], 'second stale click must produce a new ask (scroll trigger)')
  const bad = await w.fetch('/api/auth/reauth', { method: 'POST', body: JSON.stringify({ password: 'wrong' }) })
  assert.equal(bad.status, 403, 'wrong password stays refused')
  assert.equal(asks.length, 2, 'a wrong-password refusal is not a reauth_required ask')
  assert.equal((await w.fetch('/api/auth/reauth', { method: 'POST', body: JSON.stringify({ password: 'right' }) })).status, 200)
  assert.equal((await w.fetch('/api/team/invite', { method: 'POST' })).status, 200, 'explicit retry succeeds after confirm')
  assert.equal(invites, 3)
})

test('#719 F1: ReauthGate scrolls on each ask sequence, not only when the method string changes', () => {
  const s = src('reauth-gate.tsx')
  assert.match(s, /scrollIntoView\([^)]*\)[^\n]*\[method, asks\]/, 'scroll effect must depend on the ask sequence')
})
