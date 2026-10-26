import test from 'node:test'
import assert from 'node:assert/strict'
import { scoreLead, scoreSearch, scoreboardMarkdown, isReachable } from '../lib/scan/scoreboard.ts'

const NOW = new Date('2026-10-26T12:00:00Z')
const good = { name: 'Pat Lee', contact: 'pat@acme.com', review_reason: null, event_date: '2026-10-01', fit: 5, contacts: [] }

test('a verified, recent, well-fitting, reachable lead is qualified', () => {
  assert.deepEqual(scoreLead(good, NOW), { verified: true, recent: true, fit: true, named: true, reachable: true, qualified: true })
})

test('each missing condition alone disqualifies', () => {
  assert.equal(scoreLead({ ...good, review_reason: 'quote_unconfirmed' }, NOW).qualified, false)
  assert.equal(scoreLead({ ...good, event_date: '2026-06-01' }, NOW).qualified, false) // 147 days old
  assert.equal(scoreLead({ ...good, event_date: null }, NOW).qualified, false) // undated never counts as recent
  assert.equal(scoreLead({ ...good, fit: 3 }, NOW).qualified, false)
  assert.equal(scoreLead({ ...good, fit: null }, NOW).qualified, false) // ungraded is not a fit
  assert.equal(scoreLead({ ...good, contact: null }, NOW).qualified, false)
})

test('a name is reported but not required; an enrichment contact makes a lead reachable', () => {
  const c = scoreLead({ ...good, name: '', contact: null, contacts: ['Sales desk - sales@acme.com'] }, NOW)
  assert.equal(c.named, false); assert.equal(c.reachable, true); assert.equal(c.qualified, true)
})

test('reachable means an email or phone, not any text', () => {
  assert.equal(isReachable('Jane Doe - VP Sales'), false)
  assert.equal(isReachable('https://linkedin.com/in/jane'), false)
  assert.equal(isReachable('+1 (614) 555-0199'), true)
  assert.equal(isReachable('info@acme.co.uk'), true)
})

test('search totals and markdown table', () => {
  const s = scoreSearch([good, { ...good, fit: 2 }, { ...good, review_reason: 'job_closed' }], NOW)
  assert.deepEqual(s, { leads: 3, verified: 2, recent: 3, fit: 2, named: 3, reachable: 3, qualified: 1 })
  const md = scoreboardMarkdown([{ search: 'Ohio | payroll', status: 'done', error: null, score: s }], { commit: 'abc123', date: '2026-10-26' })
  assert.ok(md.includes('**Qualified leads: 1**') && md.includes('Ohio / payroll') && md.includes('| **1** |'))
})

test('incomplete searches are flagged as unknown, unique companies and the pinned rubric are shown, limits stated', () => {
  const s = scoreSearch([good], NOW)
  const md = scoreboardMarkdown([
    { search: 'a', status: 'done', error: null, complete: true, score: s },
    { search: 'b', status: 'INCOMPLETE', error: 'budget_stopped', complete: false, score: scoreSearch([], NOW) },
  ], { commit: 'c', date: 'd', model: 'm', rubric: 'r123', uniqueQualified: 1, budgetUsd: 3 })
  assert.ok(md.includes('**1 of 2 searches INCOMPLETE**'))
  assert.ok(md.includes('**1 unique companies**'))
  assert.ok(md.includes('rubric r123') && md.includes('total budget $3'))
  assert.ok(md.includes('does not yet prove buyer need'))
})
