import assert from 'node:assert/strict'
import test from 'node:test'
import { composePlayRunMail } from '../lib/play-mail.ts'

const sharedProfile = JSON.stringify({ summary: 'United States founders', where: ['United States'], signals: ['hiring'] })
const mail = (query: string, watchId?: string) => composePlayRunMail({ userId: 'tenant-fixture', to: 'owner@example.invalid', jobId: '0'.repeat(24), watchId, query, icp: sharedProfile, total: 1, leads: [], base: 'https://example.invalid' })

test('#1123 run notifications name the saved search, not the profile shared with another play', () => {
  const a = mail('United States founders hiring')
  const b = mail('Marketing and lead-gen agencies in the US and Canada posting about outbound pain')
  assert.match(a.subject, /United States founders hiring/)
  assert.match(b.subject, /Marketing and lead-gen agencies/)
  assert.notEqual(a.subject, b.subject)
  assert.match(b.text, /Your play "Marketing and lead-gen agencies/)
  assert.equal(a.to, b.to)
})

test('#1123 notifications distinguish bounded headers with a long common search opening', () => {
  const prefix = 'Find local businesses actively looking for pipeline help from our team in the United States and Canada for the first time '
  const a = mail(prefix + 'dental software', 'a'.repeat(24))
  const b = mail(prefix + 'payroll software', 'b'.repeat(24))
  assert.notEqual(a.subject, b.subject)
  assert.ok(a.subject.length <= 120 && b.subject.length <= 120)
  for (const message of [a, b]) {
    const title = /from your play "(.+)"$/.exec(message.subject)?.[1]
    assert.ok(title)
    assert.ok(message.text.startsWith(`Your play "${title}" ran again`))
    assert.match(title, /\[[a-f0-9]{8}\]$/)
    assert.doesNotMatch(message.text, /pipeline help|dental software|payroll software/)
  }
  const safe = mail('Ready to help\r\nCustom-Header: Value')
  assert.doesNotMatch(safe.subject, /[\r\n]/)
})
