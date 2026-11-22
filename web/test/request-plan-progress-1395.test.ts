// Council review (opus R2): a job-board source held for want of a request plan is SKIPPED in the progress and the run report, with a plain note;
// never "ok" (that would tell the user the boards ran).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceStatusOf, skipNote } from '../lib/scan/progress.ts'

test('#1395 progress: skipped_request_plan:<reason> is skipped with a note, for every reason', () => {
  for (const r of ['error', 'schema', 'place_not_in_request', 'spend_refused', 'unavailable']) {
    assert.equal(sourceStatusOf(`skipped_request_plan:${r}`, false), 'skipped', r)
    assert.ok(skipNote(`skipped_request_plan:${r}`), `${r} has a note`)
  }
})
