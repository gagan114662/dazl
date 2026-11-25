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

test('copy matches behaviour: Autopilot is not offered in the beta (#1428), no "in seconds", "proven" or "Unlimited scans"', () => {
  const page = read('app/page.tsx'); const banner = read('app/banner.tsx')
  // #1428 (owner decision 2026-11-23): Autopilot is off for the beta, so the page no longer says it can be turned on.
  // It was pinned to "Autopilot is off unless you turn it on"; that sentence is now false for a beta user.
  assert.doesNotMatch(page, /Sending is off in this release/)
  assert.doesNotMatch(page, /unless you turn (it )?on/i)
  assert.match(page, /Autopilot is not available during the beta\./)
  assert.doesNotMatch(page, /and proven\./)
  assert.doesNotMatch(page, /Unlimited scans/)
  assert.doesNotMatch(banner, /in seconds/)
  for (const p of ['app/app/seo/brief-panel.tsx', 'app/app/seo/newsjack-panel.tsx']) assert.match(read(p), /markdownToPlain\(/, p)
})

test('homepage claims match behaviour (Instinct #326, #1042, #1428): example demo labelled, first play daily, unconfirmed leads set aside not dropped, free beta only', () => {
  const page = read('app/page.tsx'); const demo = read('app/landing-demo.tsx')
  // #1042 (decision 2026-11-12): the first play's automatic repeat code runs every day (lib/play-repeat.ts,
  // lib/play-cadence.ts); a play saved by hand still runs weekly. That lib behaviour is unchanged here.
  assert.match(read('lib/play-cadence.ts'), /DAY_S = 86400/)
  assert.match(read('lib/play-cadence.ts'), /watchIntervalS = \(auto: boolean\): number => auto \? DAY_S : WEEK_S/)
  assert.match(read('lib/play-repeat.ts'), /REPEAT_INTERVAL_S = DAY_S/)
  // #1713 (Quest on prod 2026-11-25): new plays show "Ran once, does not repeat", so the landing page must not
  // promise a re-run cadence at all; the automatic repeat feature stays with #1593.
  assert.doesNotMatch(page, /\bdaily\b|every day/i)
  assert.doesNotMatch(demo, /\bdaily\b|every day|weekly/i)
  // #1705: the step says what a Play is, without a repeat promise; the demo's Play card says the search is saved.
  assert.match(page, /saves your first search as a Play you can run again whenever you want fresh leads/)
  assert.match(demo, /Saved as a Play/)
  // The demo's people and companies are invented: labelled an example on screen and for screen readers (#1705:
  // plainly "Illustrative example", without the self-undermining "made-up" wording; Quest: label it "Example").
  assert.match(demo, /data-testid="demo-label">Illustrative example</)
  assert.match(demo, /'Illustrative example of a dazl run/)
  // The example leads are made up until real ones from a saved scan are swapped in; until then the label must show.
  const ex = read('lib/landing-examples.ts')
  assert.match(ex, /real: false/)
  assert.match(demo, /\{!EXAMPLES\.real && <div[^>]*data-testid="demo-label"/)
  assert.doesNotMatch(ex, /url: 'http/, 'made-up leads link no source')
  // Leads that fail a check are kept as held research for review, not deleted.
  assert.doesNotMatch(page, /are dropped|drops what fails/)
  assert.match(page, /A lead whose proof could not be confirmed is set aside for you to check, with the reason/)
  // #1428 (owner decision 2026-11-20): launch shows the free beta only. No Pro card, no price other than $0, and no
  // "own AI key" or "Fair-use limits apply" wording. (This used to pin the Pro card and its PRICE_DISCLOSURE line.)
  const pricing = page.slice(page.indexOf('id="pricing"'), page.indexOf('<footer'))
  assert.match(pricing, /Free during the beta/)
  // The card's one sentence about price is the terms' own (lib/legal/policy.ts FREE_BETA_TERMS): no amount anywhere.
  assert.match(pricing, /\{FREE_BETA_TERMS\}/)
  assert.match(read('lib/legal/policy.ts'), /FREE_BETA_TERMS = "dazl is free during the beta\. We don't charge you anything\./)
  assert.doesNotMatch(page, /PLAN_PRICE_USD_MONTHLY|PRICE_DISCLOSURE|>Pro<|Fair-use|own (AI )?key|upgrade|\$\d|\/mo\b/i)
  assert.doesNotMatch(page, /no overages/i)
  // The free card says what a lead's contact is, as the owner defined it: the person's own details, never a shared inbox.
  assert.match(page, /their name, title and own LinkedIn profile, plus their own work email when it is published/)
  assert.match(page, /When no personal email is published, their LinkedIn profile is the way to reach them, and you send that message yourself\./)
  assert.match(page, /Shared inboxes such as info@ or sales@ never count/)
})

test('homepage approval wording matches the sending contract (#338, #1428): you approve every email; Autopilot is not offered in the beta', () => {
  const page = read('app/page.tsx'), ap = read('lib/outreach/autopilot.ts')
  // What Autopilot does once on (its consent text): later emails go out without asking first, within limits, after the
  // first approved sends. So no categorical "nothing sends until you approve it" anywhere on the page.
  assert.match(ap, /without asking you first/)
  assert.match(ap, /after the first sends have been approved by you/)
  // #1428 (owner decision 2026-11-23): Autopilot is off for the beta. It runs only where the operator sets
  // AUTOPILOT_ENABLED=1, so the page says you approve every email and names no exception.
  // (These assertions used to require "unless you turn on Autopilot" in every approval claim.)
  assert.match(ap, /autopilotAvailable = \(env[^)]*\) => env\.AUTOPILOT_ENABLED === '1'/)
  const claims = page.split(/(?<=[.!?'])\s+/).filter(x => /\byou approve\b/i.test(x))
  assert.ok(claims.length >= 3, 'step 3, the proof strip and the free card all state it')
  for (const c of claims) assert.match(c, /You approve every (email|one)/, c)
  assert.match(page, /Every message is reviewed and sent by you, from your own Gmail\. Autopilot is not available during the beta\./)
  assert.doesNotMatch(page, /without your individual review/)
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
  // #1705: the subhead is the single first step's pitch (the app's first screen asks "Who do you want to reach?").
  // What is missing or unconfirmed is said in the proof strip in plain words.
  assert.match(page, /dazl finds buyers showing that intent right now, verifies each lead against its source, and drafts the email from your Gmail\./)
  assert.match(page, /Each ready lead shows the exact line from its source page, with the link\./)
  assert.match(page, /Anything missing, such as a date or a person, is said on the lead\./)
  // Any business is welcome; results are not promised for every market.
  assert.doesNotMatch(page, /works out who buys from you\./)
  assert.match(page, /What it finds depends on the public evidence available for your market/)
  // The demo shows held leads beside ready ones, never only a headline count.
  assert.doesNotMatch(demo, /5 leads found/)
  assert.match(demo, /2 more set aside for you to check/)
  // #1428: no "fit 5/5" or "held for review" jargon in the demo, and a local business is the first example.
  assert.doesNotMatch(demo, /fit \{l\.fit\}\/5|held for/)
  assert.match(read('lib/landing-examples.ts'), /scenarios: \[\n    \{ id: 'dental-nyc', chip: 'Dental · New York'/)
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
