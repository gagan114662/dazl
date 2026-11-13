// #1037 item 3: a brand-new email account's first play can be checked on staging without Google sign-in. TEST-ONLY: DAZL_ENV=staging +
// DAZL_STAGING_TRIAL_NO_GOOGLE (exact test addresses). Everywhere else, and for every other address, the Google prerequisite stands.
import assert from 'node:assert/strict'
import test from 'node:test'
import type { Db } from '../lib/db/client.ts'
import { trialRefusal, stagingTrialWithoutGoogle } from '../lib/billing/trial-budget.ts'
import { bothEngines } from './helpers/engines.ts'

const BASE: Record<string, string | undefined> = {
  DAZL_TRIAL_ANTHROPIC_KEY: 'sk-ant-api03-STAGINGTRIALSTAGINGTRIALSTAGINGTR', DAZL_TRIAL_SITE_READS_PER_DAY: '5',
  DAZL_TRIAL_ACCOUNT_TOTAL_USD: '1', DAZL_TRIAL_GLOBAL_DAILY_USD: '10', DAZL_TRIAL_SCAN_RESERVE_USD: '0.30',
  TINYFISH_API_KEY: 'tf-fixture', DAZL_TRIAL_TINYFISH_SEARCH_USD: '0.004', DAZL_TRIAL_TINYFISH_FETCH_USD: '0.002',
}
const user = async (db: Db, id: string, email: string) => { await db.run("INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES (?, ?, 'n', 'b', 'x', 'y')", [id, email]); return { id, email } }

test('#1037 the staging exemption: only with DAZL_ENV=staging, only exact listed addresses, no wildcards', () => {
  assert.equal(stagingTrialWithoutGoogle('qa@gmail.com', { DAZL_STAGING_TRIAL_NO_GOOGLE: 'qa@gmail.com' }), false, 'not staging: inert')
  assert.equal(stagingTrialWithoutGoogle('qa@gmail.com', { DAZL_ENV: 'production', DAZL_STAGING_TRIAL_NO_GOOGLE: 'qa@gmail.com' }), false)
  assert.equal(stagingTrialWithoutGoogle('QA@gmail.com ', { DAZL_ENV: 'staging', DAZL_STAGING_TRIAL_NO_GOOGLE: ' qa@gmail.com ,x@y.example' }), true)
  assert.equal(stagingTrialWithoutGoogle('other@gmail.com', { DAZL_ENV: 'staging', DAZL_STAGING_TRIAL_NO_GOOGLE: 'qa@gmail.com' }), false)
  assert.equal(stagingTrialWithoutGoogle('qa@gmail.com', { DAZL_ENV: 'staging', DAZL_STAGING_TRIAL_NO_GOOGLE: '*@gmail.com' }), false, 'no wildcards')
})

bothEngines('#1037 a listed password account on staging passes the Google prerequisite; production and unlisted accounts are refused google_required', async ({ db }) => {
  const qa = await user(db, 'u-qa', 'qa-1037@gmail.com')
  const other = await user(db, 'u-other', 'someone@gmail.com')
  const staging = { ...BASE, DAZL_ENV: 'staging', DAZL_STAGING_TRIAL_NO_GOOGLE: 'qa-1037@gmail.com' }
  assert.equal(await trialRefusal(db, qa, { env: staging }), null)
  assert.equal(await trialRefusal(db, other, { env: staging }), 'google_required')
  assert.equal(await trialRefusal(db, qa, { env: { ...BASE, DAZL_ENV: 'production', DAZL_STAGING_TRIAL_NO_GOOGLE: 'qa-1037@gmail.com' } }), 'google_required')
  assert.equal(await trialRefusal(db, qa, { env: { ...staging, DAZL_TRIAL_ACCOUNT_TOTAL_USD: '0.01' } }), 'account_total_cap', 'every other trial gate still applies')
})
