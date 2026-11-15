// #1238 (prod matrix, 14 Nov, 3fb162e5): chicago-law's two ready leads were both repeats of an earlier scan by the same account
// (seen_before = 1), so the leads page collapsed every ready lead behind "Show 2 leads seen in your earlier scans" and showed 0 cards,
// with "5 found / 2 source-checked" above and "No leads passed verification." below. And bangalore's one ready lead was graded fit 0 by a
// grading prompt that had no today's date (it read 2026-11-06 as "future") and let timing drag fit down. Pure tests: no network, no model.
import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyLeadsMessage, readyRepeats, visibleReadyLeads } from '../lib/scan/leads-view.ts'
import { scorePrompt } from '../lib/scan/score.ts'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// the prod rows of job 47b30d4e2ebb76dfe21d1745, shape only
const zayed = { id: 'z', company: 'Zayed Law', review_reason: null, seen_before: 1 }
const dechert = { id: 'd', company: 'Dechert LLP', review_reason: null, seen_before: 1 }
const armstrong = { id: 'a', company: 'Armstrong Teasdale', review_reason: 'outside_window_undated', seen_before: 0 }
const fresh = { id: 'f', company: 'Ogletree Deakins', review_reason: null, seen_before: 0 }

test('every ready lead a repeat: they are shown, not collapsed to 0 cards (the chicago-law case)', () => {
  assert.deepEqual(visibleReadyLeads([zayed, dechert, armstrong], false).map(l => l.company), ['Zayed Law', 'Dechert LLP'])
  assert.deepEqual(readyRepeats([zayed, dechert, armstrong]), { ready: 2, repeats: 2, collapsible: false }, 'nothing to collapse into: no toggle')
})

test('repeats beside a fresh ready lead are still tucked away until the toggle; the toggle shows them', () => {
  assert.deepEqual(visibleReadyLeads([zayed, fresh, armstrong], false).map(l => l.company), ['Ogletree Deakins'])
  assert.deepEqual(visibleReadyLeads([zayed, fresh, armstrong], true).map(l => l.company), ['Zayed Law', 'Ogletree Deakins'])
  assert.deepEqual(readyRepeats([zayed, fresh, armstrong]), { ready: 2, repeats: 1, collapsible: true })
  // a held lead is never in the ready list, repeat or not
  assert.deepEqual(visibleReadyLeads([{ ...armstrong, seen_before: 1 }], true), [])
  assert.deepEqual(readyRepeats([]), { ready: 0, repeats: 0, collapsible: false })
})

test('the empty line never says "No leads passed verification" when ready leads are only collapsed as repeats', () => {
  const m = emptyLeadsMessage('done', 0, 0, 1, 2)!
  assert.match(m, /^2 leads passed verification but were also found in your earlier scans/)
  assert.doesNotMatch(m, /No leads passed verification/)
  assert.match(emptyLeadsMessage('done', 0, 0, 0, 1)!, /^1 lead passed verification but was also found/)
  // without repeats the old lines stand
  assert.equal(emptyLeadsMessage('done', 0, 0, 1, 0), 'No leads passed verification. 1 needs your review below.')
  assert.match(emptyLeadsMessage('done', 0, 2, 0, 0)!, /2 lower-fit leads are hidden/)
})

test('the grading prompt carries today\'s date and forbids timing from lowering fit (the bangalore case)', () => {
  const lead = { company: 'Ensinger', name: '', signal: 'opened a plant in Bangalore', excerpt: 'Ensinger opened its new plant in Bangalore.', event_date: '2026-11-06', date_status: 'unverified' }
  const p = scorePrompt('ICP: manufacturers in Bangalore', [lead], new Date('2026-11-14T12:00:00Z'))
  assert.match(p, /Today is 2026-11-14\. Any date before today is in the past\./)
  assert.match(p, /Timing NEVER lowers fit\./)
  assert.ok(scorePrompt('ICP', [lead]).includes(new Date().toISOString().slice(0, 10)), 'defaults to the real today')
})

test('#1238 route seam: GET /api/leads carries repeat_count (real handler, no network)', () => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts', '--loader', './test/helpers/scan-route-loader.mjs', '--test-reporter=tap', '--test', './test/helpers/leads-route-repeat-1238-runtime.mts'],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# pass 1/); assert.match(r.stdout, /# fail 0/)
})
