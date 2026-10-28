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

test('homepage claims match behaviour (Instinct #326): example demo labelled, weekly plays, held not dropped, provider costs at Pro', () => {
  const page = read('app/page.tsx'); const demo = read('app/landing-demo.tsx')
  // lib/watch.ts schedules a play's next run a week out; nothing runs daily.
  assert.match(read('lib/watch.ts'), /WEEK_S = 7 \* 86400/)
  for (const t of [page, demo]) assert.doesNotMatch(t, /\bdaily\b|every day/i)
  assert.match(demo, /Live · runs weekly/)
  // The demo's people and companies are invented: labelled on screen and for screen readers.
  assert.match(demo, /data-testid="demo-label">Illustrative example · made-up companies and people</)
  assert.match(demo, /'Illustrative example of a dazl run, with made-up companies and people/)
  // The example leads are made up until real ones from a saved scan are swapped in; until then the label must show.
  const ex = read('lib/landing-examples.ts')
  assert.match(ex, /real: false/)
  assert.match(demo, /\{!EXAMPLES\.real && <div[^>]*data-testid="demo-label"/)
  assert.doesNotMatch(ex, /url: 'http/, 'made-up leads link no source')
  // Leads that fail a check are kept as held research for review, not deleted.
  assert.doesNotMatch(page, /are dropped|drops what fails/)
  assert.match(page, /held for your review, out of the ready-to-contact list/)
  // Pro is a flat dazl fee; AI usage on the user's own key is billed by the provider, stated on the Pro card itself.
  const pro = page.slice(page.indexOf('>Pro<'), page.indexOf('Start free, upgrade any time'))
  assert.match(pro, /your provider bills that usage separately/)
  assert.doesNotMatch(page, /no overages/i)
})

test('homepage approval wording is exact (Hermes): nothing sends until approved; autopilot opt-in, account-wide', () => {
  const page = read('app/page.tsx')
  assert.match(page, /Nothing sends until you approve it/)
  assert.match(page, /Autopilot is off unless you turn it on; it has a sending limit you set and starts only after you have approved your first sends/)
  // Autopilot is one switch per account (lib/outreach/autopilot.ts autopilot_settings keyed by tenant): no per-Play claim.
  assert.match(read('lib/outreach/autopilot.ts'), /tenant_id TEXT PRIMARY KEY/)
  assert.doesNotMatch(page, /which Plays it covers/)
  // The warm-up the wording relies on: the first sends are approved by the user.
  assert.match(read('lib/outreach/autopilot.ts'), /WARMUP_SENDS/)
  // No BYOK or trial-scan wording in the hero.
  const hero = page.slice(page.indexOf('<h1'), page.indexOf('<LandingDemo'))
  assert.doesNotMatch(hero, /BYOK|own (AI )?key|trial/i)
})
