import test from 'node:test'
import assert from 'node:assert/strict'
import { parsePolicy, policyProblems, preflight, calibratedDailyCap, LAUNCH_POLICY_VERSION, MAX_AUDIENCE_PLAYS, MAX_BENCHMARKS, MAX_EXCLUSIONS, MAX_LAUNCH_SPEND_USD, ROLLOUT_DAILY_CAP, type LaunchPolicy, type PreflightInput, type SampleDraft } from '../lib/outreach/launch-policy.ts'
import { WARMUP_SENDS } from '../lib/outreach/autopilot.ts'

// Synthetic sender, prospects and plays.
const policy = (over: Partial<LaunchPolicy> = {}): LaunchPolicy => ({
  version: LAUNCH_POLICY_VERSION, sender: 'founder@seller.test', audience: { playIds: ['play-1'] },
  exclusions: { domains: ['customer.test'], emails: ['ceo@partner.test'] }, dailyCap: 20, spendCapUsd: 25,
  claims: { mayStatePrice: true, benchmarkUrls: [] }, stops: { pauseOnAnyReply: false, maxBounceRate: 0.05 },
  testInbox: 'founder@seller.test', ...over,
})
const sample = (i: number, over: Partial<SampleDraft> = {}): SampleDraft => ({ leadId: `l${i}`, to: `buyer${i}@prospect${i}.test`, body: 'Saw your second clinic opening.', evidenceOk: true, dateOk: true, contactOk: true, claimIssues: [], ...over })
const input = (over: Partial<PreflightInput> = {}): PreflightInput => ({
  policy: policy(), acceptedVersion: LAUNCH_POLICY_VERSION, connectedMailbox: 'founder@seller.test', testInboxDelivered: true,
  samples: [sample(1), sample(2), sample(3)], stopsEnforced: { reply: true, optOut: true, bounce: true, uncertainPause: true, domainCap: true }, ...over,
})

test('a complete accepted policy with passing checks launches without hand approvals; warmup default is unchanged', () => {
  assert.deepEqual(preflight(input()), { ok: true, failures: [], heldLeads: [] })
  assert.equal(WARMUP_SENDS({}), 10)
})

test('policy problems: limits, owned test inbox only, https benchmarks, current version', () => {
  assert.deepEqual(policyProblems(policy()), [])
  assert.deepEqual(policyProblems(policy({ dailyCap: 500 })), ['daily_cap_invalid'])
  assert.deepEqual(policyProblems(policy({ spendCapUsd: 0 })), ['spend_cap_invalid'])
  assert.deepEqual(policyProblems(policy({ stops: { pauseOnAnyReply: true, maxBounceRate: 0.5 } })), ['bounce_stop_invalid'])
  assert.deepEqual(policyProblems(policy({ audience: { playIds: [' '] } })), ['audience_empty'])
  // calibration mail never goes to an arbitrary address: only the sender or its own domain
  assert.deepEqual(policyProblems(policy({ testInbox: 'someone@prospect.test' })), ['test_inbox_not_owned'])
  assert.deepEqual(policyProblems(policy({ testInbox: 'founder@seller.test' })), [])
  // a shared domain proves nothing: another mailbox on the sender's domain, or on a consumer domain, is not owned
  assert.deepEqual(policyProblems(policy({ testInbox: 'qa@seller.test' })), ['test_inbox_not_owned'])
  assert.deepEqual(policyProblems(policy({ sender: 'founder@gmail.com', testInbox: 'unrelated-person@gmail.com' })), ['test_inbox_not_owned'])
  assert.deepEqual(policyProblems(policy({ sender: 'founder@gmail.com', testInbox: 'Founder@Gmail.com' })), [])
  assert.deepEqual(policyProblems(policy({ claims: { mayStatePrice: true, benchmarkUrls: ['http://x.test'] } })), ['benchmark_not_https'])
  assert.deepEqual(policyProblems(policy({ version: '2026-01-01' })), ['version_not_current'])
})

test('stale or missing acceptance and a different connected mailbox hold the launch', () => {
  assert.ok(preflight(input({ acceptedVersion: null })).failures.includes('policy_not_accepted'))
  assert.ok(preflight(input({ acceptedVersion: '2026-01-01' })).failures.includes('policy_not_accepted'))
  assert.ok(preflight(input({ connectedMailbox: 'other@seller.test' })).failures.includes('mailbox_mismatch'))
  assert.ok(preflight(input({ connectedMailbox: null })).failures.includes('mailbox_mismatch'))
  assert.ok(preflight(input({ testInboxDelivered: false })).failures.includes('test_inbox_failed'))
})

test('failed identity/date/contact/claim checks and excluded recipients hold the named samples', () => {
  const r = preflight(input({ samples: [sample(1, { dateOk: false }), sample(2, { claimIssues: ['unbenchmarked_comparison'] }), sample(3, { to: 'x@customer.test' }), sample(4, { contactOk: false }), sample(5, { evidenceOk: false }), sample(6)] }))
  assert.equal(r.ok, false)
  assert.deepEqual(r.heldLeads, ['l1', 'l2', 'l3', 'l4', 'l5'])
  for (const f of ['sample_date', 'sample_claims', 'sample_excluded', 'sample_contact', 'sample_evidence'] as const) assert.ok(r.failures.includes(f), f)
  assert.ok(preflight(input({ samples: [sample(1), sample(2)] })).failures.includes('too_few_samples'))
  assert.ok(preflight(input({ samples: [sample(1), sample(2), sample(3, { to: 'CEO@partner.test' })] })).failures.includes('sample_excluded'))
})

test('a policy whose JSON would not fit the store is refused by name, never a CHECK violation at accept (#405 council R2-2)', () => {
  const domains = Array.from({ length: 400 }, (_, i) => `excluded-customer-${i}.example.test`)
  const big = policy({ exclusions: { domains, emails: [] } })
  assert.ok(JSON.stringify(big).length > 8000)
  assert.deepEqual(policyProblems(big), ['policy_too_large'])
  assert.deepEqual(policyProblems(policy({ exclusions: { domains: domains.slice(0, 100), emails: [] } })), [])
})

test('numbers in a policy are numbers: a boolean is not a cap of 1; the spend cap has a ceiling (#405 council R2-5)', () => {
  const raw = { ...policy(), dailyCap: true, spendCapUsd: '25', stops: { pauseOnAnyReply: true, maxBounceRate: '0.05' } }
  assert.deepEqual(policyProblems(parsePolicy(raw)).sort(), ['bounce_stop_invalid', 'daily_cap_invalid', 'spend_cap_invalid'])
  assert.deepEqual(policyProblems(parsePolicy({ ...policy(), spendCapUsd: MAX_LAUNCH_SPEND_USD + 1 })), ['spend_cap_invalid'])
  assert.deepEqual(policyProblems(parsePolicy({ ...policy(), spendCapUsd: MAX_LAUNCH_SPEND_USD })), [])
  assert.deepEqual(policyProblems(parsePolicy(policy())), [])
})

test('R3-9: an over-long list is refused by name, never truncated: entry 501 of an exclusion list is never silently dropped', () => {
  const domains = (n: number) => Array.from({ length: n }, (_, i) => `x${i}.t`)
  const over = parsePolicy({ ...policy(), exclusions: { domains: domains(MAX_EXCLUSIONS + 1), emails: [] } })
  assert.equal(over.exclusions.domains.length, MAX_EXCLUSIONS + 1, 'the parser keeps one past the limit, enough to refuse')
  assert.equal(parsePolicy({ ...policy(), exclusions: { domains: domains(5000), emails: [] } }).exclusions.domains.length, MAX_EXCLUSIONS + 1, 'and reads no more than that of an oversize list')
  assert.deepEqual(policyProblems(over), ['exclusions_too_many'])
  assert.deepEqual(policyProblems(parsePolicy({ ...policy(), exclusions: { domains: domains(MAX_EXCLUSIONS), emails: [] } })), [])
  assert.deepEqual(policyProblems(parsePolicy({ ...policy(), exclusions: { domains: [], emails: Array.from({ length: MAX_EXCLUSIONS + 1 }, (_, i) => `e${i}@x.t`) } })), ['exclusions_too_many'])
  assert.deepEqual(policyProblems(parsePolicy({ ...policy(), audience: { playIds: Array.from({ length: MAX_AUDIENCE_PLAYS + 1 }, (_, i) => `p${i}`) } })), ['audience_too_many'])
  assert.deepEqual(policyProblems(parsePolicy({ ...policy(), claims: { mayStatePrice: true, benchmarkUrls: Array.from({ length: MAX_BENCHMARKS + 1 }, (_, i) => `https://b${i}.t/`) } })), ['benchmarks_too_many'])
})

test('every stop must be enforced; a missing one holds the launch', () => {
  for (const k of ['reply', 'optOut', 'bounce', 'uncertainPause', 'domainCap'] as const) {
    const stops = { ...input().stopsEnforced, [k]: false }
    assert.ok(preflight(input({ stopsEnforced: stops })).failures.includes('stop_not_enforced'), k)
  }
})

test('rollout cap: strict for the first week, then the policy cap, never above the ceiling', () => {
  const t0 = 1_800_000_000
  assert.equal(calibratedDailyCap(policy(), t0, t0 + 3600), ROLLOUT_DAILY_CAP)
  assert.equal(calibratedDailyCap(policy({ dailyCap: 2 }), t0, t0 + 3600), 2)
  assert.equal(calibratedDailyCap(policy(), t0, t0 + 8 * 86400), 20)
  assert.equal(calibratedDailyCap(policy({ dailyCap: 999 }), t0, t0 + 8 * 86400), 50)
})

test('HOLD: stops are checked by name and fail closed; samples must be distinct leads with every field present', () => {
  // an empty, partial or wrongly-typed stops object never passes vacuously
  for (const stops of [{}, { reply: true }, { reply: true, optOut: true, bounce: true, uncertainPause: true, domainCap: 'yes' }, { other: true }])
    assert.ok(preflight(input({ stopsEnforced: stops as unknown as PreflightInput['stopsEnforced'] })).failures.includes('stop_not_enforced'), JSON.stringify(stops))
  assert.ok(preflight(input({ stopsEnforced: undefined as unknown as PreflightInput['stopsEnforced'] })).failures.includes('stop_not_enforced'))
  // the same sample, or the same lead, three times is one sample
  const one = sample(1)
  assert.ok(preflight(input({ samples: [one, one, one] })).failures.includes('too_few_samples'))
  assert.ok(preflight(input({ samples: [sample(1), sample(1, { to: 'other@prospect9.test' }), sample(1)] })).failures.includes('too_few_samples'))
  // malformed samples are invalid and do not count
  for (const bad of [{ leadId: '' }, { to: 'not-an-email' }, { body: '  ' }, { evidenceOk: undefined }, { claimIssues: undefined }]) {
    const r = preflight(input({ samples: [sample(1), sample(2), sample(3, bad as Partial<SampleDraft>)] }))
    assert.equal(r.ok, false, JSON.stringify(bad)); assert.ok(r.failures.includes('sample_invalid') && r.failures.includes('too_few_samples'), JSON.stringify(bad))
  }
  assert.deepEqual(preflight(input()), { ok: true, failures: [], heldLeads: [] })
})
