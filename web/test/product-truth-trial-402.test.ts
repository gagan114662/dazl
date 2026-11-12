// #402 live check (Hermes-PC, staging 223b3a4b): the product truth record said free trial scans need nothing
// (`requires: []`), while a password-signup account is refused `google_required`. The record's requirement and the gate now
// come from one list (TRIAL_REQUIRES); these legs hold the two together on both engines.
import assert from 'node:assert/strict'
import type { Db } from '../lib/db/client.ts'
import { trialRefusal, TRIAL_REQUIRES } from '../lib/billing/trial-budget.ts'
import { productTruth } from '../lib/product-truth.ts'
import { bothEngines } from './helpers/engines.ts'
import test from 'node:test'

const ENV: Record<string, string | undefined> = {
  DAZL_TRIAL_ANTHROPIC_KEY: 'sk-ant-api03-PRODUCTTRUTHPRODUCTTRUTHPRODUCTTR', DAZL_TRIAL_SITE_READS_PER_DAY: '5',
  DAZL_TRIAL_ACCOUNT_TOTAL_USD: '1', DAZL_TRIAL_GLOBAL_DAILY_USD: '10', DAZL_TRIAL_SCAN_RESERVE_USD: '0.30',
  TINYFISH_API_KEY: 'tf-fixture', DAZL_TRIAL_TINYFISH_SEARCH_USD: '0.004', DAZL_TRIAL_TINYFISH_FETCH_USD: '0.002',
}
const cap = (id: string) => productTruth(ENV).capabilities.find(c => c.id === id)!

test('#402 the record names the trial\'s setup prerequisite: a Google account, for scans and website reads', () => {
  assert.equal(cap('feature:trial_scans').state, 'available')
  assert.deepEqual(cap('feature:trial_scans').requires, ['google_account'])
  assert.deepEqual(cap('feature:trial_site_read').requires, ['google_account'])
  assert.deepEqual([...TRIAL_REQUIRES], ['google_account'])
})

const user = async (db: Db, id: string, email: string, google: boolean) => {
  await db.run("INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES (?, ?, 'n', 'b', 'x', 'y')", [id, email])
  if (google) await db.run("INSERT INTO oauth_identities (provider, subject, user_id) VALUES ('google', ?, ?)", [`sub-${id}`, id])
  return { id, email }
}

bothEngines('#402 the record agrees with the gate: a password account is refused google_required; with Google the requirement is met', async ({ db }) => {
  const pw = await user(db, 'u-password', 'pat@gmail.com', false)
  const g = await user(db, 'u-google', 'sam@gmail.com', true)
  const needsGoogle = cap('feature:trial_scans').requires.includes('google_account')
  assert.equal(await trialRefusal(db, pw, { env: ENV }), needsGoogle ? 'google_required' : null)
  assert.equal(await trialRefusal(db, g, { env: ENV }), null, 'a Google account passes the requirement the record names')
  assert.equal(await trialRefusal(db, pw, { env: ENV, kind: 'site_read' }), 'google_required', 'a website read has the same prerequisite')
})
