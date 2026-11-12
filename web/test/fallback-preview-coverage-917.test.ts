// #917 (Hermes live check, acceptance 3): a fallback profile preview must disclose a cut-off request. POST /api/scan/icp
// sends `coverage` (lib/scan/icp.ts fallbackCoverage); the Leads preview note (lib/error-copy.ts profilePreviewNote)
// must say only the first part is used, how much was left out and what, and never "use your words as they are".
// The rendered check is test/ui/lossy-profile.ui.mjs (388-character request, 1280 and 390).
import test from 'node:test'
import assert from 'node:assert/strict'
import { fallbackCoverage, fallbackIcp, keepStatedFundingStage, previewCoverage, type Icp } from '../lib/scan/icp.ts'
import { profilePreviewNote } from '../lib/error-copy.ts'

const LONG = ('Find independent bookkeeping firms in Ohio and Indiana with 5 to 500 staff that are hiring a controller or a senior accountant this quarter, '
  + 'run by the founder, not part of a franchise or a national chain, that use QuickBooks Online, '
  + 'and that have posted on LinkedIn about closing the monthly books faster; exclude firms that only do payroll or tax preparation for individuals or estates.')

test('#917: a fallback preview for a request over 300 characters says only its first part is used, how much was left out and the left-out text', () => {
  assert.equal(LONG.length, 388, 'fixture: the reviewer\'s 388-character request')
  const coverage = fallbackCoverage(LONG)
  assert.equal(coverage.complete, false)
  const n = profilePreviewNote(false, coverage)
  assert.match(n.text, /first part only/)
  assert.match(n.text, /Only the first 300 of your 388 characters are in this profile; the last 88 are not\./)
  assert.doesNotMatch(n.text, /as they are/, 'never claims every word was kept')
  assert.equal(n.dropped, LONG.slice(300).trim(), 'the left-out tail, shown as is')
  assert.match(n.dropped!, /exclude firms that only do payroll/, 'the dropped exclusion is visible')
})

test('#917: a complete fallback (300 characters or fewer) and an inferred profile keep their notes; untrusted coverage never throws', () => {
  assert.match(profilePreviewNote(false, fallbackCoverage('Dental practices in Ohio opening a second location')).text, /use your words as they are/)
  assert.equal(profilePreviewNote(false, fallbackCoverage('x'.repeat(300))).dropped, null, 'exactly at the cap is complete')
  assert.match(profilePreviewNote(true, undefined).text, /worked this out from your request/)
  assert.equal(profilePreviewNote(true, { complete: false, dropped: 'tail' }).dropped, 'tail', 'a cut is disclosed even under an inferred profile (the funding-stage guard fallback)')
  // unreadable coverage never claims the request's words are all used (fails closed)
  for (const bad of [undefined, null, 'x', 7, [], { complete: false }, { complete: false, dropped: '   ' }]) {
    const n = profilePreviewNote(false, bad)
    assert.doesNotMatch(n.text, /as they are/, JSON.stringify(bad) ?? 'undefined')
    assert.match(n.text, /Check that it covers everything/)
  }
  // counts missing or inconsistent: still discloses, without inventing numbers
  const n = profilePreviewNote(false, { complete: false, dropped: 'payroll only' })
  assert.match(n.text, /Only the first part of your request is in this profile\./); assert.equal(n.dropped, 'payroll only')
  for (const kept_chars of [null, '', [], true, '300']) assert.match(profilePreviewNote(false, { complete: false, dropped: 'x', kept_chars, request_chars: 388 }).text, /Only the first part of your request/, `kept_chars ${JSON.stringify(kept_chars)}: no invented count`)
})

test('#917: the funding-stage guard falling back to the request\'s words under an "inferred" profile is disclosed too (council finding)', () => {
  // a long request that states seed; the model answers Series A: keepStatedFundingStage throws that reading out and
  // returns fallbackIcp(query), the request cut to 300 characters, while the preview still calls it inferred
  const q = 'Seed funded B2B software companies in Ohio with 10 to 50 staff that are hiring their first sales leader this quarter and '
    + 'that posted about expanding into a second US region; founders still run sales themselves and they sell to mid-market finance teams; '
    + 'exclude companies that only sell to consumers or that are owned by private equity firms.'
  assert.ok(q.length > 300, 'fixture: over the cap')
  const model: Icp = { summary: 'Series A B2B software companies in Ohio hiring a first sales leader', who: ['Founder'], industries: ['Software'], sizes: ['10-50'], where: ['Ohio'], signals: ['hiring a sales leader'], exclude: [] }
  const icp = keepStatedFundingStage(q, model)
  assert.equal(icp.summary, fallbackIcp(q).summary, 'fixture: the guard fell back to the request')
  const coverage = previewCoverage(q, { icp, inferred: true })
  assert.equal(coverage?.complete, false, 'the route sends coverage for it')
  const n = profilePreviewNote(true, coverage)
  assert.doesNotMatch(n.text, /worked this out/, 'never "worked this out" for a cut request')
  assert.match(n.text, /first part only/)
  assert.match(n.dropped ?? '', /owned by private equity firms/, 'the dropped exclusion is shown')
  // a real model reading carries no coverage; a short request is complete; a non-inferred profile always gets one
  assert.equal(previewCoverage(q, { icp: model, inferred: true }), null)
  assert.deepEqual(previewCoverage('Dentists in Ottawa', { icp: fallbackIcp('Dentists in Ottawa'), inferred: false }), { complete: true })
})
