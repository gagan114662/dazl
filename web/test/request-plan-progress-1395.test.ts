// Council review (opus R2): a job-board source held for want of a request plan is SKIPPED in the progress and the run report, with a plain note;
// never "ok" (that would tell the user the boards ran).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceStatusOf, skipNote } from '../lib/scan/progress.ts'

test('#1395 progress: skipped_request_plan:<reason> is skipped with a note, for every reason', () => {
  for (const r of ['error', 'schema', 'place_not_in_request', 'spend_refused']) {
    assert.equal(sourceStatusOf(`skipped_request_plan:${r}`, false), 'skipped', r)
    assert.ok(skipNote(`skipped_request_plan:${r}`), `${r} has a note`)
  }
})

// Qodo Low (#1527): the note names the real cause. A spend refusal or a model failure never tells the user to rewrite their place.
test('#1395 progress: each skipped_request_plan reason has its own note', () => {
  const notes = ['error', 'schema', 'place_not_in_request', 'spend_refused'].map(r => skipNote(`skipped_request_plan:${r}`)!)
  assert.equal(new Set(notes).size, 4, JSON.stringify(notes))
  assert.match(notes[3], /spend limit/i)
  assert.doesNotMatch(notes[3], /city|country|place/i)
  assert.doesNotMatch(notes[0], /city and its country/i)
  assert.match(notes[2], /city and its country/i)
})
