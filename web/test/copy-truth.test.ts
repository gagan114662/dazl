import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { markdownToPlain } from '../lib/text/plain.ts'

// Issue #199: marketing copy must not contradict product behaviour; briefs must not show raw markdown.
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

test('briefs render as readable text: no heading or emphasis marks, links keep their text, line breaks stay', () => {
  assert.equal(markdownToPlain('## Title\n\n**Bold** point with a [link](https://x.example) and `code`\n* item one\n\n\n\nEnd'), 'Title\n\nBold point with a link and code\n- item one\n\nEnd')
  assert.equal(markdownToPlain('keep snake_case_word'), 'keep snake_case_word')
})

test('copy matches behaviour: no "approve every send" vs autopilot contradiction, no "in seconds", "proven" or "Unlimited scans"', () => {
  const page = read('app/page.tsx'); const banner = read('app/banner.tsx')
  assert.doesNotMatch(page, /You approve every send/)
  assert.doesNotMatch(page, /Sending is off in this release/)
  assert.match(page, /Autopilot is off unless you turn it on/)
  assert.doesNotMatch(page, /and proven\./)
  assert.doesNotMatch(page, /Unlimited scans/)
  assert.doesNotMatch(banner, /in seconds/)
  for (const p of ['app/app/seo/brief-panel.tsx', 'app/app/seo/newsjack-panel.tsx']) assert.match(read(p), /markdownToPlain\(/, p)
})
