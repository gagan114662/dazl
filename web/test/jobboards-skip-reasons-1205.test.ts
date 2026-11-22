// #1205 (Quest live check, prod 37d46761, job fbaf13daab0953fc2aa1a9c3): the job-board source "neither ran on the place nor said why it
// skipped". The runner records WHY it was not selected (runner.ts: skipped_explicit_sources / skipped_no_hiring_signal / skipped_no_place:...),
// but only the place reasons had words: the other two read as the bare "Not used for this search". Every status the runner records for the
// job-board source carries a plain reason, in the progress row and in the saved run report.
// Pure functions only: no HTTP, no key, no DB.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { progressOf, skipNote } from '../lib/scan/progress.ts'

// the statuses the runner can record for adapter:jobboards when it does not select it (the exact ledger.record line in runner.ts)
const RUNNER = readFileSync(new URL('../lib/scan/runner.ts', import.meta.url), 'utf8')
const SKIP_LINE = RUNNER.split('\n').find(l => l.includes("ledger.record('adapter:jobboards'"))!
const RECORDED = [...SKIP_LINE.matchAll(/'(skipped_[a-z_]+)'/g)].map(m => m[1])

test('#1205 every status the runner records for a job-board source it did not select has a plain reason', () => {
  assert.ok(SKIP_LINE, 'the runner records why the job-board source was not selected')
  assert.deepEqual(RECORDED.sort(), ['skipped_explicit_sources', 'skipped_no_hiring_signal'])
  for (const status of RECORDED) {
    const note = skipNote(status)
    assert.ok(note && note.length > 20, `${status}: ${note}`)
    assert.doesNotMatch(note!, /Not used for this search|skipped|_/, `${status}: plain words, not the status`)
  }
})

test('#1205 a request not read as hiring says the job boards need a hiring request, and what to add (live row shape)', () => {
  // the row as the status route reads it from scan_source_runs for the prod run
  const [row] = progressOf([{ collector: 'adapter:jobboards', status: 'skipped_no_hiring_signal', evidence_count: 0, candidate_count: null, verified_count: null, review_count: null }], 'done')
  assert.equal(row.status, 'skipped')
  assert.equal(row.note, "Job postings are searched only for companies that are hiring. Add the role to your search, e.g. 'hiring a sales rep'.")
})

test('#1205 a search limited to chosen sources says the job boards were not among them', () => {
  const [row] = progressOf([{ collector: 'adapter:jobboards', status: 'skipped_explicit_sources', evidence_count: 0, candidate_count: null, verified_count: null, review_count: null }], 'done')
  assert.equal(row.note, 'This search used only the sources you chose, and job postings were not one of them.')
})

test('#1205 the place reasons are unchanged, and other sources\' statuses get no job-board wording', () => {
  assert.equal(skipNote('skipped_no_place:region:Europe'), "'Europe' is a region. Job postings need a city, e.g. 'Berlin, Germany'.")
  assert.equal(skipNote('skipped_hold'), null)
  assert.equal(skipNote('ok'), null)
})
