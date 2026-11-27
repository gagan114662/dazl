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
