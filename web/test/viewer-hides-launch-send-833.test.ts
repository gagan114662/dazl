// #833: a viewer cannot launch or send. The routes already refuse a viewer with 403 (test/helpers/tenant-route-roles-runtime.mts
// sweeps every session route against lib/workspaces.ts ACTIONS); this holds the UI half: a viewer is not shown the
// controls that launch a play run or send an email, while operators and up still are.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { showsAction } from '../app/app/use-role.ts'

test('showsAction hides operate and send from a viewer only; an unknown role (not loaded yet, or the read failed) still shows them', () => {
  for (const action of ['operate', 'send'] as const) {
    assert.equal(showsAction('viewer', action), false, `viewer ${action}`)
    for (const role of ['operator', 'admin', 'owner']) assert.equal(showsAction(role, action), true, `${role} ${action}`)
    for (const unknown of [null, undefined, '', 'guest']) assert.equal(showsAction(unknown, action), true, `${String(unknown)} ${action}`)
  }
  assert.equal(showsAction('viewer', 'read'), true)
})

test('Plays "Find leads now" and Outreach "Send now" render only when the role allows them', () => {
  const plays = readFileSync(new URL('../app/app/plays/plays-client.tsx', import.meta.url), 'utf8')
  assert.match(plays, /const role = useRole\(\)/)
  assert.match(plays, /\{p\.active && showsAction\(role, 'operate'\) && <button[^\n]*data-testid="play-run-now"/)
  const outreach = readFileSync(new URL('../app/app/outreach/outreach-client.tsx', import.meta.url), 'utf8')
  assert.match(outreach, /const role = useRole\(\)/)
  assert.match(outreach, /showsAction\(role, 'send'\) && <button[^\n]*>Send now<\/button>/)
})
