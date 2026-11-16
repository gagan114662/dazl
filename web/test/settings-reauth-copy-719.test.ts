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
