// #917 (Hermes live check, acceptance 3): a fallback profile preview must disclose a cut-off request. POST /api/scan/icp
// sends `coverage` (lib/scan/icp.ts fallbackCoverage); the Leads preview note (lib/error-copy.ts profilePreviewNote)
// must say only the first part is used, how much was left out and what, and never "use your words as they are".
// The rendered check is test/ui/lossy-profile.ui.mjs (388-character request, 1280 and 390).
import test from 'node:test'
import assert from 'node:assert/strict'
import { fallbackCoverage } from '../lib/scan/icp.ts'
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
  assert.equal(profilePreviewNote(true, { complete: false, dropped: 'tail' }).dropped, null, 'an inferred profile is not a fallback')
  for (const bad of [null, 'x', 7, [], { complete: false }, { complete: false, dropped: '   ' }, { complete: false, dropped: 'tail', kept_chars: 'a' }]) {
    const n = profilePreviewNote(false, bad)
    assert.equal(typeof n.text, 'string')
  }
  // counts missing or inconsistent: still discloses, without inventing numbers
  const n = profilePreviewNote(false, { complete: false, dropped: 'payroll only' })
  assert.match(n.text, /Only the first part of your request is in this profile\./); assert.equal(n.dropped, 'payroll only')
})
