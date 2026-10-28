import { test } from 'node:test'
import assert from 'node:assert/strict'
import { countsText, sourceName, stateText } from '../lib/scan/source-progress-copy.ts'
import { progressOf } from '../lib/scan/progress.ts'

test('source names are plain words; unknown sources are readable', () => {
  assert.equal(sourceName('search:tinyfish'), 'Web search')
  assert.equal(sourceName('search:news'), 'News articles')
  assert.equal(sourceName('adapter:jobboards'), 'Job postings')
  assert.equal(sourceName('adapter:some_new_thing'), 'Some new thing')
})

test('state and counts read from the recorded rows; an unknown count is "-", never 0', () => {
  const rows = progressOf([
    { collector: 'search:tinyfish', status: 'ok', evidence_count: 12, candidate_count: 4, verified_count: 2, review_count: 1 },
    { collector: 'search:news', status: 'started' },
    { collector: 'adapter:jobboards', status: 'skipped_no_hiring_signal' },
    { collector: 'adapter:github', status: 'error_timeout' },
    { collector: 'search:anthropic', status: 'ok', candidate_count: 3, verified_count: null, review_count: null },
    { collector: 'adapter:rss', status: 'empty', candidate_count: 0 },
    { collector: 'adapter:pages', status: 'partial:1_of_3', candidate_count: 0 },
  ], 'running')
  assert.deepEqual(rows.map(p => [sourceName(p.source), stateText(p), countsText(p)]), [
    ['Web search', 'Done', '4 found · 2 checked · 1 to review · 1 rejected'],
    ['News articles', 'Searching...', null],
    ['Job postings', 'Not used for this search', null],
    ['GitHub', 'Failed', null],
    ['Web research with your AI key', 'Done', '3 found · - checked · - to review · - rejected'],
    ['Feeds', 'No results', null],
    ['Web pages', 'Partly answered', '0 found · - checked · - to review · - rejected'],
  ])
})
