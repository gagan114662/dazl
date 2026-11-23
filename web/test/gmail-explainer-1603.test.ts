// #1603: the page shown before Google's own screens. Until Google has reviewed dazl's app, Google shows "Google hasn't
// verified this app"; the page names that warning in Google's words, gives the clicks past it, and says what dazl asks
// for. Pinned: the wording, that it promises nothing about reading mail beyond "does not ask", that the warning steps go
// once the app is verified, and that the page's button is the one that starts Google's flow.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { GMAIL_CONNECT_START, GMAIL_EXPLAINER_PATH, gmailExplainer, googleAppVerified } from '../lib/auth-google-explainer.ts'
import { ROUTE_TEMPLATES } from '../lib/ops/routes.ts'

test('#1603 unverified app: the warning is named in Google\'s words, with the clicks past it, before the permission', () => {
  const x = gmailExplainer({})
  assert.ok(x.warning, 'shown by default: the app is not verified')
  assert.match(x.warning.lead, /Google hasn't verified this app/)
  const steps = x.warning.steps.join(' | ')
  assert.match(steps, /"Advanced"/)
  assert.match(steps, /"Go to dazl\.ai \(unsafe\)"/)
  assert.ok(steps.indexOf('Advanced') < steps.indexOf('Go to dazl.ai'), 'in the order Google shows them')
  assert.match(x.asks.join(' '), /send email from your address/)
  assert.match(x.asks.join(' '), /does not ask to read, change or delete your mail/)
  const all = [x.title, x.warning.lead, ...x.warning.steps, ...x.asks, x.cta, x.back].join(' ')
  assert.doesNotMatch(all, /verified by Google|Google has approved|safe to ignore|review is in progress/i, 'no claim about a review that has not been asked for')
  assert.doesNotMatch(all, /[—–]/, 'plain punctuation')
})

test('#1603 once Google has verified the app the warning steps go; what dazl asks for stays', () => {
  for (const v of ['1', 'true', 'ON']) assert.equal(googleAppVerified({ DAZL_GOOGLE_APP_VERIFIED: v }), true)
  for (const v of [undefined, '', '0', 'no']) assert.equal(googleAppVerified({ DAZL_GOOGLE_APP_VERIFIED: v }), false)
  const x = gmailExplainer({ DAZL_GOOGLE_APP_VERIFIED: '1' })
  assert.equal(x.warning, null)
  assert.deepEqual(x.asks, gmailExplainer({}).asks)
})

test('#1603 the page exists at its address, shows this copy, and its button starts the Gmail connection', () => {
  assert.equal(GMAIL_EXPLAINER_PATH, '/app/connect-gmail')
  assert.ok(ROUTE_TEMPLATES.includes(GMAIL_EXPLAINER_PATH))
  const page = readFileSync(new URL('../app/app/connect-gmail/page.tsx', import.meta.url), 'utf8')
  assert.match(page, /gmailExplainer\(\)/)
  assert.match(page, /href=\{GMAIL_CONNECT_START\}/)
  assert.equal(GMAIL_CONNECT_START, '/api/gmail/connect')
  assert.ok(ROUTE_TEMPLATES.includes(GMAIL_CONNECT_START))
})
