import { test } from 'node:test'
import assert from 'node:assert/strict'
import { outcomes, INBOX_CAP, type OutcomeMsg, type OutcomeReply } from '../lib/outcomes.ts'
import type { PreviewLead } from '../lib/journey.ts'

const lead = (id: string, o: Partial<PreviewLead> = {}): PreviewLead => ({ id, company: `Co ${id}`, signal: 's', source_url: 'https://n.example/a', evidence_excerpt: 'q', event_date: '2026-10-01', date_status: 'verified', review_reason: null, fit: 4, intent: 4, why: 'w', icp_match: null, company_domain: `${id}.example`, contact: `a@${id}.example`, quarantined_at: null, confidence: 90, human_confirmed_at: null, currentness_held: false, window_held: false, enrichments: [], ...o })
const msg = (id: string, lead_id: string, status: string): OutcomeMsg => ({ id, lead_id, to_email: `a@${lead_id}.example`, subject: 'Hi', status, created_at: 1, sent_at: status === 'sent' ? 2 : null })
const reply = (lead_id: string | null, classification: string): OutcomeReply => ({ gmail_id: `g${lead_id}${classification}`, thread_id: `t${lead_id}${classification}`, lead_id, from_email: 'x@y.example', excerpt: 'e', classification, received_at: 3, company: null, lead_name: null, stopped: null })
const J = 'a'.repeat(24)

test('sorts one play into opportunities, drafts, approved-unsent, sent, conversations and exceptions', () => {
  const o = outcomes({ jobId: J, scanFailed: null,
    leads: [lead('1'), lead('2'), lead('3', { review_reason: 'identity_mismatch' })],
    messages: [msg('m1', '1', 'draft'), msg('m2', '2', 'approved'), msg('m3', '2', 'sent'), msg('m4', '1', 'uncertain'), msg('other', 'zz', 'draft')],
    replies: [reply('2', 'positive'), reply('1', 'other'), reply('1', 'opt_out'), reply('2', 'auto'), reply('zz', 'positive'), reply(null, 'positive')] })
  assert.equal(o.split?.opportunities.length, 2)
  assert.deepEqual(o.drafts?.map(m => m.id), ['m1'], 'another play\'s draft is never counted')
  assert.deepEqual(o.approved?.map(m => m.id), ['m2'])
  assert.deepEqual(o.sent?.map(m => m.id), ['m3'])
  assert.deepEqual(o.conversations?.rows.map(r => [r.lead_id, r.classification]), [['2', 'positive'], ['1', 'other']], 'only this play\'s people, and not a no, opt-out or auto-reply')
  assert.equal(o.conversations?.complete, true)
  assert.deepEqual(o.exceptions?.map(e => e.kind), ['send', 'held'])
})

test('what did not load is unknown, never zero; a capped reply list is marked incomplete', () => {
  const o = outcomes({ jobId: J, scanFailed: 'Failed', leads: null, messages: null, replies: null })
  assert.equal(o.split, null); assert.equal(o.drafts, null); assert.equal(o.conversations, null); assert.equal(o.exceptions, null)
  const capped = outcomes({ jobId: J, scanFailed: null, leads: [lead('1')], messages: [], replies: Array.from({ length: INBOX_CAP }, () => reply('1', 'positive')) })
  assert.equal(capped.conversations?.complete, false)
})

test('a stopped thread never counts as a conversation that needs the owner', () => {
  const stopped = { ...reply('1', 'positive'), stopped: 'replied' }
  const o = outcomes({ jobId: J, scanFailed: null, leads: [lead('1'), lead('2')], messages: [], replies: [stopped, { ...reply('2', 'other'), stopped: 'opt_out' }, reply('2', 'positive')] })
  assert.deepEqual(o.conversations?.rows.map(r => [r.lead_id, r.stopped]), [['2', null]])
})

test('approved-but-unsent emails are reported even with zero drafts', () => {
  const o = outcomes({ jobId: J, scanFailed: null, leads: [lead('1')], messages: [msg('a1', '1', 'approved')], replies: [] })
  assert.deepEqual(o.drafts, [])
  assert.deepEqual(o.approved?.map(m => m.id), ['a1'])
})

test('two replies in one thread are one conversation; the newest reply decides', () => {
  const r = (gmail_id: string, thread_id: string, classification: string, received_at: number): OutcomeReply => ({ ...reply('1', classification), gmail_id, thread_id, received_at })
  const o = outcomes({ jobId: J, scanFailed: null, leads: [lead('1')], messages: [], replies: [r('a', 't1', 'positive', 10), r('b', 't1', 'other', 20), r('c', 't2', 'positive', 5), r('d', 't2', 'opt_out', 6)] })
  assert.deepEqual(o.conversations?.rows.map(x => [x.thread_id, x.gmail_id]), [['t1', 'b']], 't1 counts once (its newest reply); t2 ended with an opt-out')
})

test('a reply held for review (uncertain, thread stopped for review) needs the owner; other stopped threads do not', () => {
  const held = { ...reply('1', 'uncertain'), stopped: 'review' }, opted = { ...reply('2', 'other'), stopped: 'opt_out' }
  const o = outcomes({ jobId: J, scanFailed: null, leads: [lead('1'), lead('2')], messages: [], replies: [held, opted] })
  assert.deepEqual(o.conversations?.rows.map(r => [r.lead_id, r.classification]), [['1', 'uncertain']])
})
