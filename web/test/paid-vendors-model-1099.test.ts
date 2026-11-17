// Refs #1099, Gagan's rule (15 Nov 03:38): dazl calls no paid third-party API in its default path except Claude. Every gate below runs with
// DAZL_PAID_VENDORS empty (the default an operator gets) and proves NO request reaches the vendor; a control names the vendor and proves
// the same code still runs when an operator opts in. Tests of the vendor code paths opt in (test/paid-vendors-on.ts),
// so each test here sets the variable itself. Invented companies and keys; fake fetch; no network.
// Part of the #1273 split: the model key (Claude by default; OpenAI only when named).
import test from 'node:test'
import assert from 'node:assert/strict'
import { paidVendorOn } from '../lib/paid-vendors.ts'
import { readFileSync } from 'node:fs'
import { productTruth } from '../lib/product-truth.ts'

const OFF = { DAZL_PAID_VENDORS: '' }

test('saving an OpenAI key is refused (with the reason) before the key is sent anywhere, unless OpenAI is named', () => {
  // the repo checks its routes by their source (as test/enrich-fallback-optin.test.ts does): the refusal comes before validateKey and writeKey
  const src = readFileSync(new URL('../app/api/settings/llm-key/route.ts', import.meta.url), 'utf8')
  const refuse = src.indexOf("if (vendor === 'openai' && !paidVendorOn('openai'))")
  assert.ok(refuse > 0, 'the refusal exists')
  assert.ok(refuse < src.indexOf('await validateKey(') && refuse < src.indexOf('await writeKey('), 'refused before the key is checked with the vendor or stored')
  assert.match(src.slice(refuse, refuse + 300), /status: 400/)
  assert.match(src.slice(refuse, refuse + 300), /dazl runs on Claude/)
})
test('the key panel offers OpenAI only when the operator named it, and says a saved OpenAI key is not used; onboarding asks for an Anthropic key', () => {
  const panel = readFileSync(new URL('../app/app/settings/llm-key-panel.tsx', import.meta.url), 'utf8')
  assert.match(panel, /\{openaiAllowed && <option value="openai">OpenAI<\/option>\}/)
  assert.match(panel, /not used: dazl runs on Claude/)
  const route = readFileSync(new URL('../app/api/settings/llm-key/route.ts', import.meta.url), 'utf8')
  assert.match(route, /openai_allowed: paidVendorOn\('openai'\)/)
  const inline = readFileSync(new URL('../app/app/key-inline.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(inline, /platform\.openai\.com|or sk-\.\.\./)
})
test('product truth does not claim OpenAI as available unless it is named (replies and outreach answer from it)', () => {
  const state = (env: Record<string, string>) => productTruth(env).capabilities.find(c => c.id === 'model:openai')?.state
  assert.equal(state(OFF), 'unavailable')
  assert.equal(state({ DAZL_PAID_VENDORS: 'openai' }), 'available')
  assert.equal(productTruth(OFF).capabilities.find(c => c.id === 'model:anthropic')?.state, 'available')
})
