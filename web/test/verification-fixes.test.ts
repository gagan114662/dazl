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

test('emptyLeadsMessage: done scan whose leads all need review says so instead of "no leads"', () => {
  assert.equal(emptyLeadsMessage('done', 0, 0, 1), 'No leads passed verification. 1 needs your review below.')
  assert.equal(emptyLeadsMessage('done', 0, 0, 2), 'No leads passed verification. 2 need your review below.')
  // Fit-hidden still wins when both apply - the hidden toggle sits right above.
  assert.equal(emptyLeadsMessage('done', 0, 2, 1), 'The scan found nothing above your fit bar - 2 lower-fit leads are hidden below.')
  assert.equal(emptyLeadsMessage('running', 0, 0, 1), 'This scan is still running. Leads appear here when it finishes.')
})

test('emptyLeadsMessage: not done yet, and never shown over a non-empty list', () => {
  assert.equal(emptyLeadsMessage('pending', 0, 0), 'This scan is queued and has not started yet. Leads appear here after it runs.')
  assert.equal(emptyLeadsMessage('running', 0, 0), 'This scan is still running. Leads appear here when it finishes.')
  assert.equal(emptyLeadsMessage('done', 3, 2), null)
})

test('scoreLabel: fit-0 lead is labelled not a fit instead of showing a high score', () => {
  assert.equal(scoreLabel(95, 0, 3), 'not a fit')
  assert.equal(scoreLabel(95, 0), 'scoring failed')
  assert.equal(scoreLabel(95, 0, null), 'scoring failed')
})

test('scoreLabel (#198): a graded lead shows its grade, never the discovery score; ungraded shows relevance labelled as such', () => {
  assert.equal(scoreLabel(85, 4, 0), 'fit 4/5, no live trigger confirmed') // the #198 case: displayed 85 with intent 0
  assert.equal(scoreLabel(95, 1), 'fit 1/5')
  assert.equal(scoreLabel(40, 5, 3), 'fit 5/5, timing 3/5')
  assert.equal(scoreLabel(72, null), 'relevance 72 (not graded)')
})

test('emptyLeadsMessage: a running, loading or failed scan never says "No leads yet. Run a scan."', () => {
  for (const st of ['pending', 'running', 'loading', 'failed']) assert.doesNotMatch(emptyLeadsMessage(st, 0, 0) ?? '', /Run a scan/)
  assert.match(emptyLeadsMessage('running', 0, 0) ?? '', /still running/)
  assert.equal(emptyLeadsMessage('', 0, 0), 'No leads yet. Run a scan.')
})

test('scoreLabel: hand-saved and job-feed leads are not graded, not given the column default', () => {
  assert.equal(scoreLabel(50, null, null, 'hiring_feed'), 'not graded')
  assert.equal(scoreLabel(50, null, null, 'manual_source'), 'not graded')
  assert.equal(scoreLabel(50, null, null, null), 'relevance 50 (not graded)')
  assert.equal(scoreLabel(80, 4, 3, 'hiring_feed'), 'fit 4/5, timing 3/5') // #198: a graded lead shows its grade
})

test('quoteNote: a found literal check is not erased by blanket unverified wording', async () => {
  const { quoteNote } = await import('../lib/scan/leads-view.ts')
  assert.match(quoteNote(true).prefix, /found on the page by a literal check/)
  assert.match(quoteNote(true).confirmed, /literal check/)
  assert.equal(quoteNote(false).prefix, 'Unconfirmed quote: ')
  assert.equal(quoteNote(undefined).confirmed, 'confirmed by you - dazl did not verify the quote')
})
