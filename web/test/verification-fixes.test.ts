import test from 'node:test'
import assert from 'node:assert/strict'
import { followupAsk } from '../lib/outreach/followups.ts'
import { emptyLeadsMessage, scoreLabel } from '../lib/scan/leads-view.ts'

test('followupAsk: connected Gmail + switch off asks for the switch, not a reconnect', () => {
  assert.equal(followupAsk({ enabled: false, account: 'me@gmail.com' }), 'switch')
})

test('followupAsk: no Gmail connection asks to connect', () => {
  assert.equal(followupAsk({ enabled: false, account: null }), 'connect')
})

test('followupAsk: follow-ups on asks for nothing', () => {
  assert.equal(followupAsk({ enabled: true, account: 'me@gmail.com' }), 'none')
  assert.equal(followupAsk({ enabled: true, account: null }), 'none')
})

test('emptyLeadsMessage: done scan with fit-hidden leads says so instead of "no leads"', () => {
  assert.equal(emptyLeadsMessage('done', 0, 2), 'The scan found nothing above your fit bar - 2 lower-fit leads are hidden below.')
  assert.equal(emptyLeadsMessage('done', 0, 1), 'The scan found nothing above your fit bar - 1 lower-fit lead is hidden below.')
})

test('emptyLeadsMessage: done scan with truly nothing keeps the honest line', () => {
  assert.equal(emptyLeadsMessage('done', 0, 0), 'The scan finished with no leads.')
})

test('emptyLeadsMessage: not done yet, and never shown over a non-empty list', () => {
  assert.equal(emptyLeadsMessage('running', 0, 0), 'No leads yet. Run a scan.')
  assert.equal(emptyLeadsMessage('done', 3, 2), null)
})

test('scoreLabel: fit-0 lead is labelled not a fit instead of showing a high score', () => {
  assert.equal(scoreLabel(95, 0), 'not a fit')
})

test('scoreLabel: scoring keeps showing for any lead with fit left or not yet scored', () => {
  assert.equal(scoreLabel(95, 1), 'score 95')
  assert.equal(scoreLabel(72, null), 'score 72')
  assert.equal(scoreLabel(40, 4), 'score 40')
})
