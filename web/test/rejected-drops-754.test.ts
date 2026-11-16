// #754: the companies a later run left out because the tenant rejected them are named to the user, in plain words,
// with the reason and an undo (the existing feedback reset). Pure: run report fates + active feedback rows.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rejectedLeftOut, leftOutSummary } from '../lib/scan/rejected-drops.ts'

const report = [{ candidates: [
  { company: 'Eleven Dental', fate: 'dropped:previously_rejected:wrong_industry:82d75171dd02ca21f6cf8476' },
  { company: 'Eleven Dental', fate: 'dropped:previously_rejected:wrong_industry:82d75171dd02ca21f6cf8476' },
  { company: 'Dore Dental Clinic', fate: 'dropped:previously_rejected:competitor:ae785210998cd29781d899d2' },
  { company: 'Undone Co', fate: 'dropped:previously_rejected:not_useful:000000000000000000000001' },
  { company: 'Other', fate: 'dropped:stale_date' },
  { company: 'Kept', fate: 'verified' },
] }]
const active = [
  { id: '82d75171dd02ca21f6cf8476', lead_id: 'a'.repeat(24), reason: 'wrong_industry' },
  { id: 'ae785210998cd29781d899d2', lead_id: 'b'.repeat(24), reason: 'competitor' },
]

test('#754: each company left out as previously rejected is named once, with its reason, feedback id and the lead to undo from', () => {
  assert.deepEqual(rejectedLeftOut(report, active), [
    { company: 'Eleven Dental', reason: 'wrong_industry', label: 'wrong industry', feedback_id: '82d75171dd02ca21f6cf8476', lead_id: 'a'.repeat(24) },
    { company: 'Dore Dental Clinic', reason: 'competitor', label: 'a competitor', feedback_id: 'ae785210998cd29781d899d2', lead_id: 'b'.repeat(24) },
  ])
})

test('#754: a rejection already undone is not listed; no report means nothing listed', () => {
  assert.equal(rejectedLeftOut(report, active).some(r => r.company === 'Undone Co'), false)
  assert.deepEqual(rejectedLeftOut(null, active), [])
})

test('#754: the summary is plain words naming each company and reason, never the raw code', () => {
  const s = leftOutSummary(rejectedLeftOut(report, active))
  assert.equal(s, '2 companies you rejected were left out: Eleven Dental (wrong industry), Dore Dental Clinic (a competitor).')
  assert.equal(s.includes('previously_rejected'), false)
  assert.equal(leftOutSummary(rejectedLeftOut(report, active).slice(0, 1)), '1 company you rejected was left out: Eleven Dental (wrong industry).')
  assert.equal(leftOutSummary([]), '')
})
