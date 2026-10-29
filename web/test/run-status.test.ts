import { test } from 'node:test'
import assert from 'node:assert/strict'
import { campaignStatus, runStatusOf } from '../lib/run-status.ts'

const J = 'a'.repeat(24)
const job = (o: Record<string, unknown>) => ({ id: J, status: 'done', error: null, candidates: 0, verified: 0, needs_review: 0, dropped: 0, lead_count: 0, ...o })
const row = { id: J, next: { label: 'Search failed. Open it to see why', href: `/app/leads?job_id=${J}` } }

test('the London case: a run that extracted nothing is "Nothing extracted" with its own next step, not "failed"', () => {
  const r = campaignStatus(row, job({ status: 'failed', error: 'no_candidates', empty_reason: '12 search results, 4 pages read, 0 extracted' }))
  assert.deepEqual([r.run?.group, r.run?.tag, r.run?.label, r.run?.detail], ['extraction', 'Nothing extracted', 'No candidates were extracted', '12 search results, 4 pages read, 0 extracted'])
  assert.deepEqual(r.next, { label: 'See what the scan read', href: `/app/leads?job_id=${J}` })
})

test('technical failures, stops, no-match and results each have their own state and next action', () => {
  const s = (o: Record<string, unknown>) => { const r = runStatusOf(job(o) as never); return `${r.group}|${r.tag}|${r.next?.text ?? ''}` }
  assert.equal(s({ status: 'failed', error: 'key_rejected' }), 'technical|Technical failure|Check your AI key in Settings')
  assert.equal(s({ status: 'failed', error: 'no_candidates', failed_sources: ['search:news'] }), 'technical|Technical failure|Try again', 'a failed source is never an empty search')
  assert.equal(s({ status: 'failed', error: 'scan_timeout' }), 'technical|Stopped|Try a narrower search')
  assert.equal(s({ search_hits: 0 }), 'no_match|Completed, no matches|Widen the search')
  assert.equal(s({ candidates: 3, dropped: 3 }), 'no_match|Completed, none passed the checks|' + runStatusOf(job({ candidates: 3, dropped: 3 }) as never).next!.text)
  assert.equal(s({ candidates: 4, verified: 2, needs_review: 1, dropped: 1, lead_count: 3 }), 'results|Leads found|')
  assert.equal(s({ status: 'running' }), 'running|Running|')
  // An older run without recorded check counts: results when it saved leads, otherwise it says what is not recorded.
  assert.equal(s({ candidates: null, verified: null, needs_review: null, dropped: null, lead_count: 4 }).split('|').slice(0, 2).join('|'), 'results|Leads found (counts not recorded)')
  assert.equal(s({ candidates: null, verified: null, needs_review: null, dropped: null, lead_count: 0 }).split('|').slice(0, 2).join('|'), 'extraction|Not recorded')
})

test('a run with results keeps the pipeline next action; a row with no record is unchanged', () => {
  const pipeline = { id: J, next: { label: 'Review and approve 2 drafts', href: '/app/outreach' } }
  assert.deepEqual(campaignStatus(pipeline, job({ candidates: 4, verified: 2, lead_count: 2 })).next, pipeline.next)
  assert.deepEqual(campaignStatus(row, null), { ...row, run: null })
  const running = { id: J, next: { label: 'Search still running', href: `/app/leads?job_id=${J}` } }
  assert.deepEqual(campaignStatus(running, job({ status: 'running' })).next, running.next)
})
