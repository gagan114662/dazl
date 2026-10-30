import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { productTruth, qualifyRequirements, claimIssues, requirementKey } from '../lib/product-truth.ts'
import { CHANNELS } from '../lib/channels.ts'
import { PLAN_PRICES_USD_MONTH } from '../lib/pricing.ts'

test('truth record is derived from shipped config and versioned by content', () => {
  const t = productTruth()
  assert.deepEqual(t.senders, ['gmail'])
  assert.deepEqual(t.crm, ['hubspot', 'pipedrive', 'webhook'])
  assert.deepEqual(t.modelVendors, ['anthropic', 'openai'])
  assert.deepEqual(t.sources.live, CHANNELS.filter(c => c.status === 'live').map(c => c.id))
  assert.ok(t.sources.operatorWorker.includes('linkedin'))
  assert.deepEqual(t.plans.find(p => p.id === 'pro'), { id: 'pro', usdPerMonth: 49, scansPerMonth: null })
  assert.ok(t.costExclusions.some(c => /own AI key/.test(c)))
  assert.match(t.version, /^[0-9a-f]{12}$/)
  assert.equal(productTruth().version, t.version)
})

test('the landing page states the price from the same source', () => {
  const page = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8')
  assert.match(page, /PLAN_PRICES_USD_MONTH\.pro/)
  assert.doesNotMatch(page, /\$49/)
  assert.equal(PLAN_PRICES_USD_MONTH.pro, 49)
})

test('qualification: a buyer needing only shipped capability is a fit', () => {
  const q = qualifyRequirements(['send from our Gmail', 'push to HubSpot'])
  assert.equal(q.verdict, 'fit')
  assert.deepEqual(q.unavailable, [])
  assert.equal(q.truthVersion, productTruth().version)
})

test('qualification: an unavailable sender, channel or CRM waitlists, never promises', () => {
  for (const [req, key] of [['must send from Outlook / Office 365', 'sender:outlook'], ['we need WhatsApp sequences', 'channel:whatsapp'], ['LinkedIn InMail automation', 'channel:linkedin_messaging'], ['syncs with Salesforce', 'crm:salesforce'], ['SMS follow-ups', 'channel:sms']] as const) {
    const q = qualifyRequirements(['Gmail is fine', req])
    assert.equal(q.verdict, 'waitlist', req)
    assert.deepEqual(q.unavailable, [key], req)
  }
})

test('qualification: operator-dependent sources and unrecognised needs go to review, not to fit', () => {
  assert.deepEqual(qualifyRequirements(['leads from LinkedIn']).operator, ['source:linkedin'])
  assert.equal(qualifyRequirements(['leads from LinkedIn']).verdict, 'needs_review')
  const q = qualifyRequirements(['SOC 2 report', 'Gmail'])
  assert.equal(q.verdict, 'needs_review')
  assert.deepEqual(q.unknown, ['SOC 2 report'])
  assert.equal(requirementKey('SOC 2 report'), null)
})

test('claims: an unavailable capability offered is flagged; a negated mention is not', () => {
  const bad = claimIssues('dazl sends from Outlook and syncs to Salesforce.')
  assert.deepEqual(bad.map(i => i.kind === 'unavailable_capability' && i.capability).sort(), ['crm:salesforce', 'sender:outlook'])
  assert.deepEqual(claimIssues("dazl does not support Outlook yet; it sends from your Gmail."), [])
})

test('claims: a comparison needs a linked benchmark for that competitor with a scope', () => {
  const text = 'dazl finds better leads than Gojiberry. It beats ChatGPT at lead research.'
  assert.deepEqual(claimIssues(text).map(i => i.kind === 'unbenchmarked_comparison' && i.competitor), ['Gojiberry', 'ChatGPT'])
  const bench = [{ competitor: 'Gojiberry', url: 'https://dazl.ai/benchmarks/1', scope: '50 SaaS accounts, Oct 2026' }]
  assert.deepEqual(claimIssues(text, bench).map(i => i.kind === 'unbenchmarked_comparison' && i.competitor), ['ChatGPT'])
  // a benchmark without a scope, or without an https link, does not count
  assert.equal(claimIssues(text, [{ ...bench[0], scope: ' ' }]).length, 2)
  assert.equal(claimIssues(text, [{ ...bench[0], url: 'dazl.ai/b' }]).length, 2)
})

test('claims: a price needs the own-key / separate provider cost disclosure', () => {
  assert.deepEqual(claimIssues('Pro is $49 per month.').map(i => i.kind), ['missing_cost_disclosure'])
  assert.deepEqual(claimIssues('Pro is $49/mo and runs on your own AI key; your provider bills that usage separately.'), [])
  assert.deepEqual(claimIssues('Happy to show you how it works.'), [])
})
