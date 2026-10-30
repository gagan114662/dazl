import test from 'node:test'
import assert from 'node:assert/strict'
import { scoreboardMarkdown, isReachable, SCOREBOARD_RUBRIC, type SearchScore } from '../lib/scan/scoreboard.ts'

// Qualification itself is the product's actionable function; see test/scoreboard-actionable.test.ts (#378).
const score = (over: Partial<SearchScore> = {}): SearchScore => ({ leads: 3, source_checked: 2, fit: 2, current_event: 2, right_person: 1, reachable: 1, email_ready: 1, phone_only: 0, qualified: 1, ...over })

test('isReachable is shape only: an email or a phone, not any text', () => {
  assert.equal(isReachable('Jane Doe - VP Sales'), false)
  assert.equal(isReachable('https://linkedin.com/in/jane'), false)
  assert.equal(isReachable('+1 (614) 555-0199'), true)
  assert.equal(isReachable('info@acme.co.uk'), true)
})

test('markdown: every stage is its own column, the qualification rubric is named', () => {
  const md = scoreboardMarkdown([{ search: 'Ohio | payroll', status: 'done', error: null, score: score() }], { commit: 'abc123', date: '2026-10-26' })
  assert.ok(md.includes('**Qualified leads: 1**') && md.includes('Ohio / payroll') && md.includes('| **1** |'))
  assert.ok(md.includes('| Search | Status | Candidates | Source-checked | Fit | Current event | Right person | Reachable (email / phone) | Qualified |'))
  assert.ok(md.includes('| 3 | 2 | 2 | 2 | 1 | 1 (1 / 0) |'))
  assert.ok(md.includes(SCOREBOARD_RUBRIC))
})

test('incomplete searches are flagged as unknown, unique companies and the pinned rubric are shown, limits stated', () => {
  const md = scoreboardMarkdown([
    { search: 'a', status: 'done', error: null, complete: true, score: score() },
    { search: 'b', status: 'INCOMPLETE', error: 'budget_stopped', complete: false, score: score({ leads: 0, source_checked: 0, fit: 0, current_event: 0, right_person: 0, reachable: 0, email_ready: 0, qualified: 0 }) },
  ], { commit: 'c', date: 'd', model: 'm', rubric: 'r123', uniqueQualified: 1, budgetUsd: 3 })
  assert.ok(md.includes('**1 of 2 searches INCOMPLETE**'))
  assert.ok(md.includes('**1 unique companies**'))
  assert.ok(md.includes('rubric r123') && md.includes('total budget $3'))
  assert.ok(md.includes('does not yet prove buyer need'))
})
