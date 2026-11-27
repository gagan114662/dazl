import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const cases = [
  ['outreach/outreach-client.tsx', 'You can review this draft, but you cannot approve or send it yet.'],
  ['outreach/sequences-client.tsx', 'Follow-ups are turned on. A message sends only when it is due and your sending checks pass.'],
  ['outreach/sequences-client.tsx', 'Recent follow-up activity:'],
  ['outreach/sequences-client.tsx', 'Your messages are saved, but no more steps will send while this lead is on hold.'],
  ['leads/leads-client.tsx', 'If you confirm a lead, your list will show that you checked it yourself.'],
  ['leads/leads-client.tsx', 'No recent source confirms who works at this company.'],
  ['leads/leads-client.tsx', 'dazl has not confirmed when the signal happened or whether it still applies.'],
  ['settings/autopilot-panel.tsx', 'Automatic sending is off. Emails send only when you click Send.'],
] as const

for (const [file, copy] of cases) {
  test(`customer copy in ${file}: ${copy}`, () => {
    const source = readFileSync(new URL(`../app/app/${file}`, import.meta.url), 'utf8')
    assert.ok(source.includes(copy), `Expected customer copy: ${copy}`)
  })
}

test('saved outreach errors explain the failure without displaying server codes', () => {
  const source = readFileSync(new URL('../app/app/outreach/outreach-client.tsx', import.meta.url), 'utf8')
  assert.match(source, /messageErrorCopy\(m\.error\)/)
  assert.doesNotMatch(source, /\$\{m\.error\}/)
  assert.ok(source.includes('Check the message status before trying again.'))
})
