// Refs #1099, Gagan's rule (15 Nov 03:38): no paid third-party API in dazl's default path except Claude. DAZL_PAID_VENDORS empty = off; a control names the vendor.
// Split B of #1273: OpenAI keys are not used unless the operator names them. No network.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { usableVendor } from '../lib/paid-vendors.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { migrateKeys, saveKey, defaultVendor, hasKey, readHasKey } from '../lib/llm/key-store.ts'
import { readFileSync } from 'node:fs'
import { productTruth } from '../lib/product-truth.ts'

const OFF = { DAZL_PAID_VENDORS: '' }
const master = randomBytes(32)

test('model vendor: a saved OpenAI key is not used unless named; the Anthropic key is used even when it is older', async () => {
  const db = new Database(':memory:'); migrateKeys(db)
  saveKey(db, 't1', 'anthropic', 'sk-ant-' + 'a'.repeat(40), master)
  db.prepare("UPDATE tenant_llm_keys SET created_at = created_at - 100 WHERE tenant_id = 't1'").run()
  saveKey(db, 't1', 'openai', 'sk-' + 'b'.repeat(40), master)
  assert.equal(defaultVendor(db, 't1', OFF), 'anthropic')
  saveKey(db, 't2', 'openai', 'sk-' + 'c'.repeat(40), master)
  // ...and every intake gate (scan, play, watch, CSV, estimate) sees it as keyless up front, instead of accepting a scan that cannot run
  assert.equal(hasKey(db, 't2', OFF), false); assert.equal(hasKey(db, 't1', OFF), true)
  assert.equal(hasKey(db, 't2', { DAZL_PAID_VENDORS: 'openai' }), true)
  // the Db-layer read the watch, play, usage and estimate gates use (council round 2)
  assert.equal(await readHasKey(sqliteDb(db), 't2', OFF), false); assert.equal(await readHasKey(sqliteDb(db), 't1', OFF), true)
  assert.equal(usableVendor([{ vendor: 'openai' }, { vendor: 'anthropic' }], OFF)?.vendor, 'anthropic')
})

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
