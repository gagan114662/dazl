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
  assert.equal(playPace({ ...job, status: 'running' }, []).status, 'running')
  // The watch list could not be read: the schedule is unknown, never "Ran once".
  const u = playPace(job, null)
  assert.deepEqual([u.label, u.pace.endsWith('schedule unavailable')], ['Done', true]); assert.doesNotMatch(u.pace, /once/i)
  assert.equal(playPace({ ...job, status: 'failed', error: 'no_candidates' }, null).label, 'No results')
  assert.match(playPace({ ...job, status: 'running' }, null).pace, /schedule unavailable/)
  assert.equal(playPace({ ...job, status: 'failed', error: 'cancelled' }, []).label, 'Stopped')
  assert.equal(playPace({ ...job, status: 'failed', error: 'no_candidates' }, []).label, 'No results', 'finding nothing is not a failure')
})

test('pills keep every constraint in a fixed order', () => {
  assert.deepEqual(constraintPills({ who: ['Owner'], where: ['NYC'], window_days: 90, signals: ['Hiring'], exclude: ['chains'] }).map(p => p.text), ['Owner', 'in NYC', 'past 90 days', 'Hiring', 'skip chains'])
})

test('widen actions: only the window number is rewritten; place and signal open the full request unchanged', () => {
  const q = 'Founders of London B2B SaaS startups (10-50 staff) that announced seed funding in the past 90 days and are currently hiring sales staff; skip agencies and recruiters; I need founder contacts.'
  const icp = { summary: 'London B2B SaaS startups that announced seed funding in the past 90 days and are currently hiring sales staff', where: ['London'], sizes: ['10-50 employees'], window_days: 90, signals: ['Seed funding', 'Hiring sales staff'], exclude: ['Agencies', 'Recruiters'], who: ['Founder'] }
  const a = widenActions(q, icp)
  assert.deepEqual(a.map(x => x.label), ['Widen to 180 days', 'Change the place', 'Change the signal'])
  const prefill = (x: { href: string }) => decodeURIComponent(x.href.split('q=')[1])
  assert.equal(prefill(a[0]), q.replace('90 days', '180 days'), 'only the day count changes')
  for (const x of a) for (const kept of ['London', '10-50 staff', 'skip agencies and recruiters', 'I need founder contacts']) assert.ok(prefill(x).includes(kept), `${x.label} keeps "${kept}"`)
  assert.equal(prefill(a[1]), q, 'the place is changed by the user, from the full request')
  assert.equal(prefill(a[2]), q, 'the signal is changed by the user, from the full request; nothing claims it was dropped')
  assert.ok(!a.some(x => /drop/i.test(x.label)))
  assert.ok(a.every(x => x.href.startsWith('/app/leads?q=')))
})

test('widen window only when the request states the saved window as "<N> days"', () => {
  assert.deepEqual(widenActions('Dental owners in NYC opening a second office', { window_days: 90, where: ['NYC'] }).map(x => x.label), ['Change the place'], 'no window in the text: nothing is appended or guessed')
  assert.deepEqual(widenActions('Dental owners, past 60 days', { window_days: 90 }).map(x => x.label), ['Add a place'], 'a different number in the text is not the saved window')
  assert.deepEqual(widenActions('Dental owners in the past 365 days', { window_days: 365 }).map(x => x.label), ['Add a place'])
})
