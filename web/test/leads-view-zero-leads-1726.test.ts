// #1726: the zero-lead message wiring in lib/scan/leads-view.ts. The bare fallback
// 'The scan finished with no leads.' now carries the scan outcome's plain reason when the
// outcome is known, and stays the bare line when it is not (nothing invented). The reason
// wording mirrors the merged no-leads-help component, and every other emptyLeadsMessage
// branch keeps precedence over the outcome.
import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyLeadsMessage, zeroLeadsLine } from '../lib/scan/leads-view.ts'

const outcome = { label: 'Zero match - the sources returned nothing', detail: 'The search and the other sources came back with no results for this request, and none of them failed.' }

test('#1726 zero-lead message: the outcome\'s plain reason, never the bare line alone', () => {
  assert.equal(zeroLeadsLine(outcome), 'Zero match - the sources returned nothing. The search and the other sources came back with no results for this request, and none of them failed.')
  assert.equal(zeroLeadsLine({ label: 'No candidates were extracted' }), 'No candidates were extracted.')
  assert.equal(zeroLeadsLine({ label: '  Not recorded  ', detail: ' ' }), 'Not recorded.')
  // nothing invented: an unknown outcome keeps the bare line
  assert.equal(zeroLeadsLine(), 'The scan finished with no leads.')
  assert.equal(zeroLeadsLine(null), 'The scan finished with no leads.')
  assert.equal(zeroLeadsLine({}), 'The scan finished with no leads.')
  assert.equal(zeroLeadsLine({ label: '   ', detail: 'text' }), 'The scan finished with no leads.')
})

test('#1726 zero-lead message: the outcome is used only in the bare fallback, other branches keep precedence', () => {
  // the bare fallback carries the outcome's reason
  assert.equal(emptyLeadsMessage('done', 0, 0, 0, 0, 0, outcome), 'Zero match - the sources returned nothing. The search and the other sources came back with no results for this request, and none of them failed.')
  // no outcome passed: the old bare line stays, so existing call sites are unchanged
  assert.equal(emptyLeadsMessage('done', 0, 0, 0, 0, 0), 'The scan finished with no leads.')
  // a lower-fit lead hidden below the bar is not the bare fallback
  assert.match(emptyLeadsMessage('done', 0, 2, 0, 0, 0, outcome)!, /2 lower-fit leads are hidden/)
  // repeats and reviews keep their branches
  assert.match(emptyLeadsMessage('done', 0, 0, 0, 1, 0, outcome)!, /^1 lead passed verification but was also found/)
  assert.equal(emptyLeadsMessage('done', 0, 0, 1, 0, 0, outcome), 'No leads passed verification. 1 needs your review below.')
  // an outcome is never shown for a scan that did not finish
  assert.equal(emptyLeadsMessage('failed', 0, 0, 0, 0, 0, outcome), 'This scan ended without leads. See the message above.')
})
