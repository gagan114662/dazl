import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readinessRows, recentPlays } from '../lib/readiness.ts'

const byId = (rows: ReturnType<typeof readinessRows>) => Object.fromEntries(rows.map(r => [r.id, r]))

test('a new account: every row is a to-do with its fix; Gmail goes to Settings where its consent text is', () => {
  const r = byId(readinessRows({ profile: { sells: '', website: '' }, usage: { has_key: false, trial: { funded: true, remaining: 2 } }, outreach: { gmail: null, sender: null } }))
  assert.deepEqual(Object.values(r).map(x => x.state), ['todo', 'todo', 'todo', 'todo'])
  assert.equal(r.key.detail, 'not added; 2 free searches left')
  assert.deepEqual(r.gmail.fix, { kind: 'link', href: '/app/settings#gmail', label: 'Connect' })
  assert.deepEqual(r.sender.fix, { kind: 'inline', label: 'Add' })
})

test('a ready account: all done, no fixes offered', () => {
  const r = readinessRows({ profile: { sells: 'Booking software', website: 'https://acme.example', business_name: 'Acme' }, usage: { has_key: true, trial: null }, outreach: { gmail: { email: 'me@acme.example', status: 'active' }, sender: { sender_name: 'Dana', postal_address: '1 Main St, Columbus OH' } } })
  assert.ok(r.every(x => x.state === 'done' && x.fix === null))
  assert.equal(byId(r).gmail.detail, 'sending from me@acme.example')
  assert.equal(byId(r).site.detail, 'Acme - Booking software (acme.example)')
})

test('a failed status load is "could not check", never done or to-do', () => {
  const r = readinessRows({ profile: null, usage: null, outreach: null })
  assert.ok(r.every(x => x.state === 'unknown' && x.fix === null))
})

test('Gmail that needs reconnecting and a half-filled sender are to-dos', () => {
  const r = byId(readinessRows({ profile: { sells: 'x', website: '' }, usage: { has_key: true }, outreach: { gmail: { email: 'a@b.example', status: 'revoked' }, sender: { sender_name: 'Dana', postal_address: '' } } }))
  assert.equal(r.site.detail, 'missing business name, website')
  assert.equal(r.gmail.fix?.label, 'Reconnect')
  assert.equal(r.sender.state, 'todo')
})

test('plays: own searches newest first with their outcome; imports and fixtures excluded', () => {
  const j = (id: string, created_at: number, o: object = {}) => ({ id, status: 'done', error: null, query: `q${id}`, csv_domain: null, created_at, lead_count: 3, verified: 3, needs_review: 0, ...o })
  const p = recentPlays([j('1', 1), j('2', 3, { status: 'failed' }), j('3', 2, { lead_count: 1, verified: 1 }), j('4', 4, { csv_domain: 'acme.com' }), j('5', 5, { test_only: true }), j('6', 6, { status: 'running', query: null })])
  assert.deepEqual(p, [{ id: '2', query: 'q2', outcome: 'failed' }, { id: '3', query: 'q3', outcome: '1 source-checked, 0 need your review' }, { id: '1', query: 'q1', outcome: '3 source-checked, 0 need your review' }])
})

// Instinct #234: a finished search whose leads are all research-only must not read as "5 leads" of yield.
test('plays never present research-only leads as yield; old records and cancelled runs say what they are', () => {
  const j = (o: object) => recentPlays([{ id: 'x', status: 'done', error: null, query: 'q', csv_domain: null, created_at: 1, lead_count: 5, ...o }])[0].outcome
  assert.equal(j({ verified: 0, needs_review: 5 }), '0 source-checked, 5 need your review', 'the real NYC shape: all five need review')
  assert.equal(j({ verified: 2, needs_review: 3 }), '2 source-checked, 3 need your review')
  assert.equal(j({ verified: 0, needs_review: 1, lead_count: 1 }), '0 source-checked, 1 needs your review')
  assert.equal(j({ verified: 0, needs_review: 0, lead_count: 0 }), '0 source-checked, 0 need your review')
  assert.equal(j({ verified: null, needs_review: null }), '5 leads, checks not recorded', 'old record: never a bare yield number')
  assert.equal(j({ status: 'failed', error: 'cancelled' }), 'cancelled')
  assert.equal(j({ status: 'failed', error: 'no_candidates' }), 'failed')
})
