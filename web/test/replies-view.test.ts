import { test } from 'node:test'
import assert from 'node:assert/strict'
import { actionMessage, replyReadingState } from '../lib/outreach/replies-view.ts'

const base = { gmail_status: 'active' as const, gmail_connected: true, read_granted: true, consent: { accepted: true } }

test('#931 on only for active account + read scope + accepted current consent (positive control)', () => {
  assert.equal(replyReadingState(base), 'on')
})

test('#931 revoked consent with read scope still granted is not "on" and needs consent, not reconnect', () => {
  assert.equal(replyReadingState({ ...base, consent: { accepted: false } }), 'consent_needed')
})

test('#931 read scope missing, disconnected, and needs_reconnect are distinct states', () => {
  assert.equal(replyReadingState({ ...base, read_granted: false }), 'read_scope_missing')
  assert.equal(replyReadingState({ ...base, gmail_status: 'none', gmail_connected: false }), 'disconnected')
  assert.equal(replyReadingState({ ...base, gmail_status: 'needs_reconnect' }), 'needs_reconnect')
  // needs_reconnect wins even with consent + scope recorded
  assert.equal(replyReadingState({ ...base, gmail_status: 'needs_reconnect', consent: { accepted: true } }), 'needs_reconnect')
})

test('#931 sync refusal is never reported as Checked replies', () => {
  assert.equal(actionMessage('sync', true, { ok: true, sync: { error: 'reading_not_enabled' } }), 'Replies were not checked: reply reading is off.')
  assert.match(actionMessage('sync', true, { ok: true, sync: { error: 'gmail_unavailable' } }), /not checked/)
  assert.match(actionMessage('sync', true, { ok: true, sync: { error: 'other' } }), /not checked/)
  assert.equal(actionMessage('sync', true, { ok: true, sync: {} }), 'Checked replies.')
  assert.equal(actionMessage('sync', false, { error: 'Too many requests' }), 'Too many requests')
  assert.equal(actionMessage('consent', true, { ok: true }), '')
})
