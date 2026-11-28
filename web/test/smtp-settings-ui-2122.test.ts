import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('Settings mounts SMTP alongside Gmail, and the form posts an app password without echoing it', () => {
  const page = read('../app/app/settings/page.tsx')
  assert.match(page, /<GmailPanel \/>[\s\S]*?<SmtpForm \/>/)
  const form = read('../app/app/settings/email/smtp-form.tsx')
  assert.match(form, /type="password"/)
  assert.match(form, /fetch\('\/api\/settings\/smtp', \{[\s\S]*?method: 'PUT'/)
  assert.match(form, /setPassword\(''\)/)
  assert.doesNotMatch(form, /localStorage|sessionStorage/)
})

test('SMTP Settings loads status and disconnects only the displayed connection', () => {
  const form = read('../app/app/settings/email/smtp-form.tsx')
  assert.match(form, /fetch\('\/api\/settings\/smtp', \{ cache: 'no-store'/)
  assert.match(form, /method: 'DELETE'[\s\S]*?JSON\.stringify\(\{ id: mailbox\.id \}\)/)
  assert.match(form, /Disconnect mailbox/)
  assert.match(form, /response\.status === 409[\s\S]*?loadMailbox/)
})
