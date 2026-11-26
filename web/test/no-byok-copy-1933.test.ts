import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { PRIVACY, TERMS } from '../lib/legal/policy.ts'

const customerKeyCopy = /\b(?:ai|anthropic|model provider) keys?\b|\byour key\b|\bkey you saved\b|\byour own model provider search\b/i

for (const [name, sections] of [['Terms', TERMS], ['Privacy', PRIVACY]] as const) {
  test(`#1933 ${name} does not advertise customer model credentials`, () => {
    const copy = sections.flatMap(section => [section.heading, ...section.paragraphs]).join('\n')
    assert.doesNotMatch(copy, customerKeyCopy)
  })
}

for (const [name, path] of [
  ['Home setup', '../app/app/page.tsx'],
  ['Outreach drafts', '../app/app/outreach/outreach-client.tsx'],
  ['Plays schedule', '../app/app/plays/plays-client.tsx'],
  ['Settings web search', '../lib/channels.ts'],
]) {
  test(`#1933 ${name} has no customer-facing AI key copy`, () => {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8')
    assert.doesNotMatch(source, customerKeyCopy)
  })
}
