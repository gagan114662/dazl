import { test } from 'node:test'
import assert from 'node:assert/strict'
import { constraintPills, playName, playPace, widenActions } from '../lib/play-card.ts'

test('a play gets a short name from its profile; the request is the fallback', () => {
  assert.equal(playName('Dental practice owners in NYC who opened a new location in the past 90 days, skip chains', { summary: 'Independent dental practices with 2-10 chairs', where: ['NYC'], signals: ['Opened a new location'] }), 'NYC dental practices expanding')
  assert.equal(playName('x', { summary: 'B2B SaaS startups, 10-50 staff', where: ['London, UK'], signals: ['Raised a seed round'] }), 'London saas startups just funded')
  assert.equal(playName('Clinic administrators hiring front-desk staff', { who: ['Clinic administrators'], signals: ['Hiring front-desk staff'] }), 'Clinic administrators hiring')
  assert.equal(playName('Find me founders of fintech companies in Lisbon raising money right now', null), 'Find me founders of fintech companies...')
})

test('pace and status come from the play and a weekly watch on the same request, nothing else', () => {
  const job = { status: 'done', error: null, created_at: Date.UTC(2026, 9, 27) / 1000, query: 'Q' }
  assert.equal(playPace(job, []).status, 'done'); assert.match(playPace(job, []).pace, /^Ran once, /)
  assert.deepEqual(playPace(job, [{ query: 'Q', active: true, next_run_at: Date.UTC(2026, 10, 3) / 1000, paused_reason: null }]).label, 'Live')
  assert.equal(playPace(job, [{ query: 'Q', active: false, next_run_at: null, paused_reason: 'quota_reached' }]).pace, 'Weekly, paused (quota reached)')
  assert.equal(playPace(job, [{ query: 'Other', active: true, next_run_at: null, paused_reason: null }]).status, 'done', 'another request\'s watch does not count')
  assert.equal(playPace({ ...job, status: 'running' }, null).status, 'running')
  assert.equal(playPace({ ...job, status: 'failed', error: 'cancelled' }, null).label, 'Stopped')
  assert.equal(playPace({ ...job, status: 'failed', error: 'no_candidates' }, null).label, 'No results', 'finding nothing is not a failure')
})

test('pills keep every constraint in a fixed order', () => {
  assert.deepEqual(constraintPills({ who: ['Owner'], where: ['NYC'], window_days: 90, signals: ['Hiring'], exclude: ['chains'] }).map(p => p.text), ['Owner', 'in NYC', 'past 90 days', 'Hiring', 'skip chains'])
})

test('widen actions only prefill Plays with a rewritten request', () => {
  const a = widenActions('Dental owners in NYC opened a new location in the past 90 days', { summary: 'Dental practices', where: ['NYC'], window_days: 90, signals: ['Opened a new location'] })
  assert.deepEqual(a.map(x => x.label), ['Widen to 180 days', 'Try another city', 'Drop the signal'])
  assert.equal(decodeURIComponent(a[0].href.split('q=')[1]), 'Dental owners in NYC opened a new location in the past 180 days')
  assert.equal(decodeURIComponent(a[2].href.split('q=')[1]), 'Dental practices in NYC')
  const b = widenActions('Dental owners', { window_days: 365 })
  assert.deepEqual(b.map(x => x.label), ['Add a city'], 'no window widening past 180, no signal to drop')
  assert.ok(a.every(x => x.href.startsWith('/app/leads?q=')))
})
