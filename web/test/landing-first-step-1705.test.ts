// #1705 (found by Quest's prod audit 2026-11-25; assignment comment on the issue, owner Instinct): the landing
// hero, the OG text and the app's real first screen must describe the same single first step: saying who you want
// to reach. The app's first screen after Google sign-in asks "Who do you want to reach?" (app/app/leads/leads-client.tsx).
// Prod findings behind this: the hero pitched "Paste your website", the OG text was a third pitch, the demo box
// looked like a real input (it typed a URL behind a cursor), the page promised "Your first Play runs again every
// day" while prod plays show "Ran once, does not repeat" (#1713; the auto-repeat feature stays with #1593), and
// /pricing said only "Free during the beta" while runs showed dollar amounts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

test('#1705: hero, steps and OG text describe the same single first step: say who you want to reach', () => {
  const page = read('app/page.tsx'), layout = read('app/layout.tsx'), leads = read('app/app/leads/leads-client.tsx')
  // The app's real first screen asks this; the landing hero and step 1 say the same thing.
  assert.match(leads, />Who do you want to reach\?</)
  assert.match(page, /Say who you want to reach\./)
  // The meta/OG description is the same first step, not a third pitch, and it does not overclaim proof:
  // dazl does not open every source page (#1716), so it shows the dated public proof for each lead.
  // Both the homepage (publicMeta argument) and the layout fallback set this wording explicitly; the
  // shared SITE_DESCRIPTION default in lib/site.ts and the OG image in app/opengraph-image.tsx still
  // carry the old wording and are outside this lane's allowed files.
  const honest = /Say who you want to reach\. dazl finds buyers showing intent and shows the dated public proof for each lead\./
  assert.match(page, honest)
  assert.match(page, /publicMeta\('\/', SITE_TITLE, LANDING_DESCRIPTION\)/)
  assert.match(layout, /description: LANDING_DESCRIPTION/)
  assert.doesNotMatch(page, /verifies each lead against its source/)
  assert.doesNotMatch(layout, /verifies each lead against its source/)
  // The old website-first pitch is gone: nothing tells people to paste a website, and no "only thing you type"
  // (that claim may return only if the first screen ever asks for a website).
  assert.doesNotMatch(page, /Paste your website|only thing you type/i)
  assert.doesNotMatch(read('app/landing-demo.tsx'), /Your website/)
})

test('#1705: the demo box does not look like a text input: it types the ask, with no cursor, labelled an example', () => {
  const demo = read('app/landing-demo.tsx')
  assert.doesNotMatch(demo, /lp-caret/, 'no blinking cursor: the box is an animation, not an input')
  assert.match(demo, />Who do you want to reach\?</, 'the box types the same ask the app starts with')
  assert.match(demo, /data-testid="demo-label">Illustrative example</, 'labelled an example, without the "made-up" wording')
  const ex = read('lib/landing-examples.ts')
  assert.match(ex, /real: false/)
  assert.doesNotMatch(ex, /url: 'http/, 'example leads link no source')
})

test('#1705 + #1713: no daily re-run promise while new plays run once (the auto-repeat stays with #1593)', () => {
  const page = read('app/page.tsx'), demo = read('app/landing-demo.tsx')
  assert.doesNotMatch(page, /every day|\bdaily\b/i)
  assert.doesNotMatch(demo, /every day|\bdaily\b/i)
  // The Plays page's own label for a first play (lib/saved-plays.ts); the landing steps must not promise more.
  assert.match(read('lib/saved-plays.ts'), /Ran once, does not repeat/)
  assert.match(page, /saves your first search as a Play/)
})

test('#1705: pricing text matches what the app charges: free beta searches on dazl, never a charge, no BYOK push', () => {
  const page = read('app/page.tsx')
  const pricing = page.slice(page.indexOf('id="pricing"'), page.indexOf('<footer'))
  assert.match(pricing, /Free during the beta/)
  assert.match(pricing, /\{FREE_BETA_TERMS\}/)
  // Counters the bait-and-switch read: starting needs no card and no AI key, and a dollar amount on a free run
  // is the provider cost dazl pays, not a charge.
  assert.match(pricing, /No card and no AI key needed to start/)
  assert.match(pricing, /paid by dazl, not a charge to you/)
  assert.doesNotMatch(pricing, /\$\d|own (AI )?key|upgrade|Fair-use/i)
})

test('#1705: the mobile header has a menu: How it works and Pricing reachable below 768px', () => {
  const page = read('app/page.tsx')
  const nav = page.slice(page.indexOf('<nav'), page.indexOf('</nav>'))
  assert.match(nav, /hidden md:flex/, 'desktop inline links stay')
  assert.match(nav, /md:hidden/, 'a mobile-only control exists')
  const menu = nav.slice(nav.indexOf('md:hidden'))
  assert.match(menu, /#how/)
  assert.match(menu, /#pricing/)
})
