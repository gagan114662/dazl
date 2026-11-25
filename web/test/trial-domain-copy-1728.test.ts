import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ACCOUNT_LOAD_FAILED, TRIAL_REFUSAL_COPY, trialCopy, trialRefusalNotice, trialRefusedCopy } from '../lib/trial-copy.ts'
import { siteKeyReason } from '../lib/scan/site-read-copy.ts'
import { TRIAL_REFUSALS } from '../lib/billing/trial-budget.ts'

// #1728: one free trial per mail domain covers every non-consumer domain, throwaway and shared ones included
// (lib/billing/trial-budget.ts), so the domain is not known to be a company's. The refusal names the email domain and
// the other account, never "your company".
const COMPANY = /compan(y|ies)|organi[sz]ation/i

test('#1728: every domain_used line names the email domain and another account, never a company', () => {
  const lines = [
    trialCopy({ funded: false, remaining: 3, cap: 3, blocked: 'domain_used' }).text,
    TRIAL_REFUSAL_COPY.domain_used.text,
    trialRefusedCopy('domain_used'),
    siteKeyReason('domain_used'),
    ...[null, ACCOUNT_LOAD_FAILED, { verified: true, google: false, fresh: true }, { verified: true, google: true, fresh: false }].map(a => trialRefusalNotice('domain_used', '/app/leads', a).text),
  ]
  for (const l of lines) {
    assert.doesNotMatch(l, COMPANY, l)
    assert.match(l, /email domain/, l)
    assert.match(l, /another account/i, l)
  }
})

test('#1728: no refusal reason calls the account\'s mail domain a company\'s', () => {
  for (const r of [...TRIAL_REFUSALS, 'site_reads_used', 'workspace_not_eligible', 'a_reason_not_known_yet']) {
    for (const l of [trialRefusedCopy(r), siteKeyReason(r), trialRefusalNotice(r, '/app', ACCOUNT_LOAD_FAILED).text]) assert.doesNotMatch(l, /company's|your company/i, `${r}: ${l}`)
  }
})
