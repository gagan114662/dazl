// #1746: Google OAuth branding. /privacy has a clearly headed "Google user data and Limited Use" section near the top (linked from the top of the page),
// with the existing wording unchanged; the homepage footer carries the exact Google APIs sentence.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PRIVACY } from '../lib/legal/policy.ts'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const LIMITED_USE = "dazl's use and transfer to any other app of information received from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements."

test('the Limited Use sentence sits in its own headed section near the top of the privacy policy', () => {
  const i = PRIVACY.findIndex(s => s.heading === 'Google user data and Limited Use')
  assert.ok(i >= 0 && i <= 1, `section index ${i}`)
  assert.deepEqual(PRIVACY[i].paragraphs, [LIMITED_USE])
  assert.equal(PRIVACY.filter(s => s.paragraphs.includes(LIMITED_USE)).length, 1, 'the sentence is moved, not copied')
})

test('the privacy page links to that section from the top', () => {
  const src = readFileSync(join(root, 'app/privacy/page.tsx'), 'utf8')
  assert.match(src, /href="#google-user-data"/)
  assert.match(src, /id=\{[^}]*'google-user-data'/)
})
