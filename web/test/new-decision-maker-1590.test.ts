// #1590: a new decision-maker is a person signal. A lead graded new_decision_maker (a person newly in a buyer role for
// the ICP, from a dated public announcement) must never be dated by a guess or by a job board's publish day: only the
// announcement or start date printed on a page counts. The discovery loop's prompt demands the person, the new title and
// the date on the proof page; a profile's "x months" text is not a date. Pure rules on invented leads; nothing is searched.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SIGNALS, primarySignalKind } from '../lib/scan/score.ts'
import { decide, eventKeyOf, DEFAULT_EVENT_WINDOW_DAYS, type RunLead } from '../lib/monitor-events.ts'

const NOW = Math.floor(Date.parse('2026-10-30T12:00:00Z') / 1000)
const W = DEFAULT_EVENT_WINDOW_DAYS
const l: RunLead = { company: 'Harbor Dental', company_domain: null, event_date: '2026-10-20', event_date_proof: 'page_bound', signal: 'named a new VP of Sales', signals: null, signal_kind: 'new_decision_maker', source_url: 'https://a.example/x', review_reason: null, confidence: 80, quarantined_at: null, fit: null, held: false, reachable: false }

test('the taxonomy owns the new kind and a graded lead keeps it as its primary kind', () => {
  assert.ok((SIGNALS as readonly string[]).includes('new_decision_maker'), 'a person newly in a buyer role is its own kind, not a company leadership_change')
  assert.equal(primarySignalKind(JSON.stringify(['new_decision_maker'])), 'new_decision_maker')
})

test('no guessed dates: an undated new decision-maker never alerts, and a job board day never dates one', () => {
  assert.deepEqual(decide({ ...l, event_date_proof: null }, null, false, 'all', W, NOW), { suppress: 'undated' })
  assert.deepEqual(decide({ ...l, event_date_proof: 'ats_structured', signal: 'Acme is hiring an Account Executive' }, null, false, 'all', W, NOW), { suppress: 'undated' }, 'a posting\u2019s publish day is not a person\u2019s start date')
})

test('a page-proven announcement date alerts and keys its own event', () => {
  assert.deepEqual(decide({ ...l }, null, false, 'all', W, NOW), { kind: 'new_company', alert: true })
  assert.equal(eventKeyOf({ ...l }), 'n:harbor dental|2026-10-20|new_decision_maker')
})

test('the discovery prompt demands the person, the new title and the date on the proof page', () => {
  const src = readFileSync(fileURLToPath(new URL('../lib/discover/agent.ts', import.meta.url)), 'utf8')
  assert.match(src, /name the person and their new title/i, 'the proof page must name who and what role')
  assert.match(src, /how long someone has been/i, 'a profile\u2019s "x months" text is never a date without a dated page')
})
