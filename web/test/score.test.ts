import test from 'node:test'
import assert from 'node:assert/strict'
import { icpTextFor, isHidden, parseScores, scorePrompt, SIGNALS } from '../lib/scan/score.ts'

test('taxonomy has 15-30 key-free signals, all snake_case ids', () => {
  assert.ok(SIGNALS.length >= 15 && SIGNALS.length <= 30)
  for (const s of SIGNALS) assert.match(s, /^[a-z][a-z0-9_]*$/)
})

test('parseScores: parses one line per lead, clamps to 0-5, keeps known signals only', () => {
  const text = `LEAD 1 | fit 4 | intent 5 | action 3 | signals raised_funding, hiring_relevant_role, made_up | why Just raised seed and hiring first AE
LEAD 2 | fit 9 | intent -2 | action 2 | signals none | why Big incumbent, no trigger`
  const s = parseScores(text, 2)
  assert.ok(s)
  assert.deepEqual(s[0], { fit: 4, intent: 5, action: 3, signals: ['raised_funding', 'hiring_relevant_role'], why: 'Just raised seed and hiring first AE' })
  assert.deepEqual(s[1], { fit: 5, intent: 0, action: 2, signals: [], why: 'Big incumbent, no trigger' })
})

test('parseScores: missing lead line fails the whole batch (no unfair ranking)', () => {
  assert.equal(parseScores('LEAD 1 | fit 4 | intent 4 | action 4 | signals hiring | why x', 2), null)
  assert.equal(parseScores('no grades here', 1), null)
})

test('isHidden: fit 0-1 hides, higher fits and unscored stay visible', () => {
  assert.equal(isHidden({ fit: 1, intent: 5, action: 5, why: '', signals: [] }), true)
  assert.equal(isHidden({ fit: 2, intent: 0, action: 0, why: '', signals: [] }), false)
  assert.equal(isHidden(null), false)
})

test('scorePrompt: carries the ICP text and every lead with its evidence', () => {
  const p = scorePrompt('ICP: seed startups hiring sales', [
    { company: 'Acme', name: 'Bob', signal: 'hired VP Sales', excerpt: 'Acme hired its first VP Sales' },
    { company: 'Beta', name: '', signal: 'raised seed', excerpt: null },
  ])
  assert.ok(p.includes('ICP: seed startups hiring sales'))
  assert.ok(p.includes('Acme hired its first VP Sales'))
  assert.ok(p.includes('LEAD 2'))
  assert.ok(p.includes('raised_funding'))
})

test('icpTextFor: renders the reviewed ICP, falls back to the raw query', () => {
  const t = icpTextFor({ summary: 'SaaS seller', who: ['VP Sales'], where: ['London'], signals: ['seed round'], exclude: ['agencies'] }, 'fallback')
  assert.ok(t.includes('SaaS seller') && t.includes('VP Sales') && t.includes('London') && t.includes('agencies'))
  assert.equal(icpTextFor(null, 'fallback'), 'fallback')
})

test('parseScores tolerates colons, commas and prose around the lines', () => {
  const text = `Here are my grades:
LEAD 1: fit 4, intent 5, action 3, signals raised_funding, hiring | why Just raised and hiring
LEAD 2 | fit: 1 | intent: 2 | action: 2 | signals: none | why: Incumbent with no trigger`
  const s = parseScores(text, 2)
  assert.ok(s)
  assert.deepEqual(s[0], { fit: 4, intent: 5, action: 3, signals: ['raised_funding', 'hiring'], why: 'Just raised and hiring' })
  assert.equal(s[1].fit, 1)
})
