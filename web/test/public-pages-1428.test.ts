// #1428 (owner decisions 2026-11-20): the public pages for launch. Free beta only (no Pro card, no own-key or fair-use
// wording), the owner's subhead and proof line, a local-business demo first, one cadence everywhere, plain words instead of
// "Play" / fit scores / "held for review", Start free goes to sign-up, sign-up says what a scan is and that creating an
// account accepts the Terms and Privacy Policy, a support address in the footer, /contact and /about answer, and one
// dazl wordmark on the homepage and the auth pages. The browser half is test/ui/landing.ui.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { EXAMPLES } from '../lib/landing-examples.ts'
import { FREE_BETA } from '../lib/free-beta.ts'
import { signUpPlanLine } from '../lib/trial-copy.ts'

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const PUBLIC = ['app/page.tsx', 'app/banner.tsx', 'app/landing-demo.tsx', 'app/free-beta-card.tsx', 'app/sign-up/sign-up-form.tsx', 'app/sign-in/page.tsx', 'app/contact/page.tsx', 'app/about/page.tsx']

test('#1428 pricing: one free-beta card on the homepage and on /pricing and /plans; no Pro card, price, own-key or fair-use wording', () => {
  const page = read('app/page.tsx'), card = read('app/free-beta-card.tsx')
  assert.doesNotMatch(page, />Pro<|PLAN_PRICE_USD_MONTHLY\.pro|PRICE_DISCLOSURE|\$49|upgrade any time/i)
  for (const p of PUBLIC) assert.doesNotMatch(read(p), /own AI key|Fair-use|fair use|PRICE_DISCLOSURE/i, p)
  assert.match(page, /<FreeBetaCard/)
  for (const p of ['app/pricing/page.tsx', 'app/plans/page.tsx']) {
    const src = read(p)
    assert.match(src, /<FreeBetaCard/, `${p} renders the same card`)
    assert.doesNotMatch(src, /redirect\(/, `${p} is a page, not a redirect`)
  }
  // the card lists what you get, in plain words, from one list
  assert.match(card, /FREE_BETA\.items\.map/)
  assert.equal(FREE_BETA.name, 'Free beta')
  assert.ok(FREE_BETA.items.length >= 4)
  for (const i of FREE_BETA.items) assert.doesNotMatch(i, /key|fair|fit \d|held for review|\bplay\b/i, i)
  assert.match(card, /href="\/sign-up"/)
})

test('#1428 home copy: the owner\'s subhead, proof-not-a-database line, Start free goes to sign-up', () => {
  const page = read('app/page.tsx'), banner = read('app/banner.tsx')
  assert.ok(page.includes('Paste your website. dazl finds businesses that need what you sell right now, shows you the proof, and drafts the email from your Gmail.'))
  assert.match(page, /data-testid="hero-contrast">Proof behind every lead, not a database dump\.</)
  for (const src of [page, banner, read('app/free-beta-card.tsx')]) assert.doesNotMatch(src, /href="\/api\/auth\/google"/, 'no public button jumps straight to Google sign-in')
  assert.doesNotMatch(banner, /early access/i)
  assert.match(banner, /href="\/sign-up"[^>]*>Start free</)
  assert.match(page, /href="\/sign-up" className="btn-primary btn-lg" data-testid="hero-cta">Start free</)
})

test('#1428 demo: a local business first, one cadence, plain words (no Play, fit score or "held for review")', () => {
  const demo = read('app/landing-demo.tsx'), page = read('app/page.tsx')
  assert.equal(EXAMPLES.scenarios[0].id, 'dental-nyc', 'the default tab is the local dental example')
  assert.equal(EXAMPLES.scenarios[0].chip, 'Dental · New York')
  // the first saved search repeats daily (lib/play-cadence.ts watchIntervalS(auto) = DAY_S; lib/play-repeat.ts): the
  // homepage and the demo say the same thing about it
  assert.match(read('lib/play-cadence.ts'), /watchIntervalS = \(auto: boolean\): number => auto \? DAY_S : WEEK_S/)
  assert.match(demo, /Live · runs every day/)
  assert.doesNotMatch(demo, /weekly/i)
  assert.match(page, /Your first search runs again every day/)
  for (const src of [demo, page]) {
    assert.doesNotMatch(src, /fit \{?l?\.?fit\}?\/5|fit \d\/5/, 'no fit score')
    assert.doesNotMatch(src, /held for (your )?review/i)
    assert.doesNotMatch(src.replace(/\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, ''), /\bPlays?\b/, 'Play is not used as a public word')
  }
})

test('#1428 sign-up: says what a scan is, never asks for a key, names the Terms and Privacy Policy acceptance', () => {
  const form = read('app/sign-up/sign-up-form.tsx'), signin = read('app/sign-in/page.tsx')
  for (const funded of [true, false]) {
    const line = signUpPlanLine(funded)
    assert.match(line, /^A scan is one search:/, 'defines scan')
    assert.doesNotMatch(line, /\bkey\b|upgrade/i)
  }
  assert.match(signUpPlanLine(true), /3 free scans/)
  assert.match(signUpPlanLine(true), /no card/)
  for (const src of [form, signin]) assert.doesNotMatch(src, /Free scans need Google sign-in/)
  assert.match(form, /By creating an account you agree to the <a href="\/terms"[^>]*>Terms<\/a> and <a href="\/privacy"[^>]*>Privacy Policy<\/a>/)
})

test('#1428 footer support address; /contact and /about are pages', () => {
  const page = read('app/page.tsx')
  assert.match(page, /href="mailto:support@dazl\.ai"/)
  for (const p of ['app/contact/page.tsx', 'app/about/page.tsx']) {
    assert.ok(existsSync(new URL(`../${p}`, import.meta.url)), `${p} exists`)
    assert.match(read(p), /support@dazl\.ai/)
  }
  assert.match(read('app/about/page.tsx'), /dazl is a product of Mathematricks - F\.Z\.E\./)
  assert.match(read('app/sitemap.ts'), /'\/contact'/)
})

test('#1428 one wordmark: the homepage nav and the auth pages use the same dazl logo component', () => {
  for (const p of ['app/page.tsx', 'app/sign-up/sign-up-form.tsx', 'app/sign-in/page.tsx', 'app/public-shell.tsx']) {
    assert.match(read(p), /<Wordmark/, p)
    assert.doesNotMatch(read(p), /dazl<span className="text-\[#111\]">\.<\/span>/, `${p}: no second logo style`)
  }
  for (const p of ['app/pricing/page.tsx', 'app/plans/page.tsx', 'app/contact/page.tsx', 'app/about/page.tsx']) assert.match(read(p), /<PublicShell>/, `${p} uses the shared public shell (its wordmark)`)
})

test('#1428 one visual style: the auth pages use the homepage\'s style scope (app-ui), not a separate look', () => {
  assert.match(read('app/page.tsx'), /className="app-ui lp /, 'the homepage style scope')
  for (const p of ['app/sign-up/sign-up-form.tsx', 'app/sign-in/page.tsx', 'app/reset/reset-form.tsx']) {
    const mains = read(p).match(/<main id="main" className="[^"]*"/g) ?? []
    assert.ok(mains.length > 0, `${p} renders a main`)
    for (const m of mains) assert.match(m, /className="app-ui /, `${p}: ${m}`)
  }
})

// Council round 1 (#1428): the public copy claims only what the product does.
test('#1428 the free card claims proof for every READY lead, never for every lead (held leads are kept out of the ready list)', () => {
  for (const item of FREE_BETA.items) assert.doesNotMatch(item, /\bevery lead\b/i, item)
  assert.ok(FREE_BETA.items.some(i => /every ready lead/.test(i)))
})
test('#1428 the Google button on sign-in creates accounts too: the Terms and Privacy acceptance line is there as on sign-up', () => {
  const src = read('app/sign-in/page.tsx')
  assert.match(src, /By continuing you agree to the <a href="\/terms"[^>]*>Terms<\/a> and <a href="\/privacy"[^>]*>Privacy Policy<\/a>/)
  assert.doesNotMatch(src, /<div className="mb-4" \/>/, 'no empty spacer left where the old line was')
})
test('#1428 the demo calls leads that failed a check kept out with the reason, not still being checked', () => {
  const demo = read('app/landing-demo.tsx')
  assert.doesNotMatch(demo, /still being checked/)
  assert.match(demo, /2 more kept out, with the reason/)
})
test('#1428 Claim with Google on a proof preview creates an account too: the same Terms and Privacy acceptance line', () => {
  const src = read('app/preview/[token]/cta.tsx')
  assert.match(src, /Claim with Google/)
  assert.match(src, /By continuing you agree to the <a href="\/terms"[^>]*>Terms<\/a> and <a href="\/privacy"[^>]*>Privacy Policy<\/a>/)
})
