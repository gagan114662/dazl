import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')

test('#1955 the audit trail shows a plain name for a test send, not the raw event id', () => {
  const panel = src('../app/app/settings/audit-panel.tsx')
  assert.match(panel, /'outreach\.test_send': 'Sent a test message'/)
  // control: labels the issue did not report keep their exact wording
  assert.match(panel, /'outreach\.send': 'Sent a message'/)
  assert.match(panel, /'data\.deleted': 'Deleted data'/)
})

test('#1955 the audit trail names the actor instead of a raw member id', () => {
  const panel = src('../app/app/settings/audit-panel.tsx')
  // the names come from the workspace member list, which every member can already read
  assert.match(panel, /\/api\/workspace\/members/)
  // a human actor renders as a resolved name when the member list knows it, and the raw id only as the fallback
  assert.match(panel, /names\[e\.actor_id\] \|\| e\.actor_id/)
  // control: service actors keep their "(automatic)" treatment
  assert.match(panel, /\(automatic\)/)
})

test('#1955 the check-email screen offers a resend for the address it already knows', () => {
  const resend = src('../app/resend-confirmation.tsx')
  assert.match(resend, /export function ResendConfirmationButton/)
  // the same route and the same copy as the existing resend form
  assert.match(resend, /send-verification/)
  assert.match(resend, /resendCopy\[state\]/)
  const form = src('../app/sign-up/sign-up-form.tsx')
  assert.match(form, /ResendConfirmationButton/)
  // control: the no-script fallback keeps pointing at password sign-in
  assert.match(form, /Sign in with your password/)
})

test('#1955 bulk session revocation uses a label that also fits when the current session was kept', () => {
  const panel = src('../app/app/settings/audit-panel.tsx')
  assert.match(panel, /'session\.revoked_all': 'Revoked sessions'/)
})
