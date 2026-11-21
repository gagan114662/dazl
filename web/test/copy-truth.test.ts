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

test('homepage claims match behaviour (Instinct #326, #1042, #1428): example demo labelled, first search daily, held not dropped, free beta only', () => {
  const page = read('app/page.tsx'); const demo = read('app/landing-demo.tsx')
  // #1042 (decision 2026-11-12): the first play's automatic repeat runs every day (lib/play-repeat.ts, lib/play-cadence.ts);
  // a play saved by hand still runs weekly. So the homepage and the demo may say "every day" only about the first search
  // (#1428: the public pages call a Play a search, and the demo shows that first search).
  assert.match(read('lib/play-cadence.ts'), /DAY_S = 86400/)
  assert.match(read('lib/play-cadence.ts'), /watchIntervalS = \(auto: boolean\): number => auto \? DAY_S : WEEK_S/)
  assert.match(read('lib/play-repeat.ts'), /REPEAT_INTERVAL_S = DAY_S/)
  assert.match(page, /Your first search runs again every day/)
  assert.equal(page.match(/\bdaily\b|every day/gi)?.length, 2, 'the step title and its first-search sentence only')
  // the demo shows a first search going live: it repeats daily, so the demo says so and never "weekly"
  assert.match(demo, /Live · runs every day/)
  assert.doesNotMatch(demo, /weekly/i)
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
  assert.match(page, /A lead that fails a check is kept out of your ready list, with the reason/)
  // #1428 (owner decision): launch shows the free beta only; no paid plan, price or provider-billing wording to keep true.
  assert.doesNotMatch(page, />Pro<|\$49|PRICE_DISCLOSURE|no overages/i)
  assert.match(page, /<FreeBetaCard \/>/)
})

test('homepage approval wording matches the sending contract (Instinct #338): approval per email unless Autopilot is on', () => {
  const page = read('app/page.tsx'), ap = read('lib/outreach/autopilot.ts')
  // What Autopilot does once on (its consent text): later emails go out without asking first, within limits, after the
  // first approved sends. So no categorical "nothing sends until you approve it" anywhere on the page.
  assert.match(ap, /without asking you first/)
  assert.match(ap, /after the first sends have been approved by you/)
  assert.doesNotMatch(page, /Nothing sends until you approve it/)
  // Every approval claim on the page names the Autopilot exception in the same sentence.
  const claims = page.split(/(?<=[.!?'])\s+/).filter(x => /\byou approve\b/i.test(x) && !/first sends/.test(x))
  assert.ok(claims.length >= 2, 'the proof strip and step 3 both state it')
  for (const c of claims) assert.match(c, /unless you turn on Autopilot/, c)
  assert.match(page, /later emails can send without your individual review/)
  // Autopilot is one switch per account (autopilot_settings keyed by tenant): no per-Play claim.
  assert.match(ap, /tenant_id TEXT PRIMARY KEY/)
  assert.doesNotMatch(page, /which Plays it covers/)
  // No BYOK or trial-scan wording in the hero.
  const hero = page.slice(page.indexOf('<h1'), page.indexOf('<LandingDemo'))
  assert.doesNotMatch(hero, /BYOK|own (AI )?key|trial/i)
})

test('homepage evidence and coverage claims match what a scan returns (Instinct #338)', () => {
  const page = read('app/page.tsx'), demo = read('app/landing-demo.tsx')
  // Undated, unconfirmed or blocked candidates stay held for review: only ready leads carry the checked evidence.
  assert.doesNotMatch(page, /Every lead (comes|shows)|Each lead comes|Evidence for every lead/)
  assert.match(page, /Each ready lead comes with the line that shows the signal, linked to its source/)
  assert.match(page, /kept out of your ready list, with the reason/)
  // Results are not promised for every market (#1428 dropped the coverage sentence; no promise replaces it).
  assert.doesNotMatch(page, /works out who buys from you\./)
  assert.doesNotMatch(page, /every market|any market|guarantee/i)
  // The demo shows the leads kept out (with the reason) beside ready ones: held, never dropped, never only a headline count.
  assert.doesNotMatch(demo, /5 leads found/)
  assert.match(demo, /2 more kept out, with the reason/)
})

test('onboarding "brain ready" copy matches behaviour: no approve-every-send, no unconditional follow-up stop, no contact-today promise', () => {
  const fr = read('app/app/first-run.tsx')
  assert.doesNotMatch(fr, /You approve every email before it sends|Follow-ups stop the moment|contact today/)
  assert.match(fr, /autopilot is off unless you turn it on/)
  assert.match(fr, /held for your review/)
})

test('first-review copy names the Autopilot exception wherever it says you approve before sending (as on the homepage, #338)', () => {
  const fr = read('app/app/onboarding/first-review.tsx')
  assert.doesNotMatch(fr, /Nothing sends until you approve/)
  const claims = fr.split(/(?<=[.!?'])\s+/).filter(x => /\bapprove\b/i.test(x) && /Outreach|\bsends?\b/.test(x))
  assert.ok(claims.length >= 2)
  for (const c of claims) assert.match(c, /unless you turn on Autopilot/, c)
})
