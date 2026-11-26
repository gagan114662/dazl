import { test } from 'node:test'
import assert from 'node:assert/strict'
import { heldReason, previewSplit, type PreviewLead } from '../lib/journey.ts'
import { ownSiteBuyerRows } from './helpers/own-site-buyer.ts'

type Candidate = { address: string; verification: string }
const base = (o: Partial<PreviewLead> & { email_candidates?: Candidate[] } = {}): PreviewLead => ({
  id: 'l1980', company: 'Acme', signal: 'Opened an office', source_url: 'https://news.example/a', evidence_excerpt: 'Acme opened an office',
  event_date: '2026-10-01', date_status: 'unverified', day_verified: true, review_reason: null, fit: 4, intent: 4, why: 'fits', icp_match: null,
  company_domain: 'acme.example', contact: 'person@acme.example', quarantined_at: null, confidence: 90, human_confirmed_at: null,
  currentness_held: false, window_held: false, enrichments: ownSiteBuyerRows('acme.example'), ...o,
})
const refusal = (address: string, verdict: string) => ({ connector: 'test', kind: 'deliverability', value: `${address}|${verdict}`, label: null, source_url: '', retrieved_at: 10 })
const reason = "email can't receive mail"
function assertHeld(l: PreviewLead) {
  assert.equal(heldReason(l), reason)
  const split = previewSplit([l])
  assert.equal(split.opportunities.length, 0)
  assert.equal(split.held.length, 1)
  assert.equal(split.held[0].lead.id, l.id)
  assert.equal(split.held[0].reason, reason)
}
function assertReady(l: PreviewLead) {
  assert.equal(heldReason(l), null)
  const split = previewSplit([l])
  assert.equal(split.opportunities.length, 1)
  assert.equal(split.opportunities[0].id, l.id)
  assert.equal(split.held.length, 0)
}

test('#1980 a sole refused email contact is held with the shared reason and remains shown', () => {
  assertHeld(base({ enrichments: [...ownSiteBuyerRows('acme.example'), refusal('person@acme.example', 'rejected')] }))
})
test('#1980 a sole refused email contact with applicable domain no_mx is held', () => {
  assertHeld(base({ enrichments: [...ownSiteBuyerRows('acme.example'), refusal('@acme.example', 'no_mx')] }))
})
test('#1980 a sole undeliverable email candidate is held', () => {
  assertHeld(base({ email_candidates: [{ address: 'person@acme.example', verification: 'undeliverable' }] }))
})
test('#1980 phone/form-only contact plus a refused guess is not held and stays shown', () => {
  assertReady(base({ contact: '+1 555 0100', email_candidates: [{ address: 'guessed@acme.example', verification: 'undeliverable' }] }))
})
test('#1980 a second verified address keeps a refused contact Ready', () => {
  assertReady(base({ email_candidates: [{ address: 'other@acme.example', verification: 'verified' }], enrichments: [...ownSiteBuyerRows('acme.example'), refusal('person@acme.example', 'rejected')] }))
})
test('#1980 catch_all, accepted, and mx_found are deliverable alternatives', () => {
  for (const verdict of ['catch_all', 'accepted', 'mx_found']) {
    assertReady(base({ enrichments: [...ownSiteBuyerRows('acme.example'), refusal('person@acme.example', 'rejected'), refusal('other@acme.example', verdict)] }))
  }
})
test('#1980 unknown, none, and unverified remain unchanged', () => {
  for (const verification of ['none', 'unverified']) {
    assertReady(base({ email_candidates: [{ address: 'person@acme.example', verification }] }))
  }
  assertReady(base({ email_candidates: [{ address: 'person@acme.example', verification: 'undeliverable' }], enrichments: [...ownSiteBuyerRows('acme.example'), refusal('person@acme.example', 'accepted')] }))
})
