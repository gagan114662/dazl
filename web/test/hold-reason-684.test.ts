// #684 (part of #352): a held lead's saved claim and its shown hold reason never contradict. Audit case: a receptionist-vacancy
// claim held as "someone else's customer" because the job board's page said its users "use" the board. Synthetic pages and
// invented companies only; no network, no provider, no spend. Imports pure modules only, so it runs standalone with bun or node.
import test from 'node:test'
import assert from 'node:assert/strict'
import { counterpartySignal } from '../lib/scan/counterparty.ts'
import { holdFitsClaim, isJobPostingClaim } from '../lib/scan/hold-fit.ts'
import { reviewAction } from '../lib/scan/review-action.ts'

const NOW = new Date('2026-11-04T12:00:00Z')
const BOARD = 'https://www.dentalpost.net/dental-jobs/front-desk-receptionist/12345/'
const VACANCY = 'Smile Dental Care is hiring a front desk receptionist for its Brooklyn office'
const boardPage = { title: 'Front Desk Receptionist - Smile Dental Care | DentalPost', text: `${VACANCY}. Full time. Smile Dental Care staff use DentalPost to schedule interviews. Apply using DentalPost in two minutes.`, retrievedAt: 1 }
const vacancy = { name: '', company: 'Smile Dental Care', contact: null, signal: 'Hiring a front desk receptionist', source_url: BOARD, score: 70, excerpt: VACANCY, event_date: null }
const weave = { name: '', company: 'Smile Dental Care', contact: null, signal: 'Smile Dental Care switched to Weave', source_url: 'https://www.weave.com/customers/smile-dental', score: 80, excerpt: 'Smile Dental Care switched to Weave for patient reminders', event_date: null }
const weavePage = { title: 'Customer story | Weave', text: 'Weave helps practices grow. Smile Dental Care switched to Weave for patient reminders this year.', retrievedAt: 1 }

test('AC-1: a job-posting claim on a job board page is never held as someone else\'s customer', () => {
  assert.equal(counterpartySignal(vacancy as never, boardPage as never, ''), null)
  assert.equal(counterpartySignal({ ...vacancy, signal: 'Front desk receptionist, Brooklyn', signal_kind: 'hiring' } as never, boardPage as never, ''), null)
  assert.equal(counterpartySignal({ ...vacancy, signal: 'Front desk receptionist, Brooklyn', source_kind: 'hiring_feed' } as never, boardPage as never, ''), null)
})

test('AC-2: a real customer story still holds the lead (gate not loosened); malformed kinds never skip it', () => {
  assert.equal(counterpartySignal(weave as never, weavePage as never, ''), 'source_owner:weave')
  for (const bad of [{ signal_kind: 42 }, { signal_kind: { hiring: true } }, { source_kind: ['hiring_feed'] }, { signal_kind: 'HIRING ' }, { signal_kind: null }])
    assert.equal(counterpartySignal({ ...weave, ...bad } as never, weavePage as never, ''), 'source_owner:weave', JSON.stringify(bad))
})

test('AC-3: isJobPostingClaim is positive string evidence only', () => {
  assert.equal(isJobPostingClaim({ signal: 'Hiring a front desk receptionist' }), true)
  assert.equal(isJobPostingClaim({ signal: 'x', signal_kind: 'hiring' }), true)
  assert.equal(isJobPostingClaim({ signal: 'x', source_kind: 'hiring_feed' }), true)
  for (const c of [{}, { signal: null }, { signal: 42 }, { signal: ['hiring'] }, { signal: 'Smile Dental Care switched to Weave' }, { signal_kind: 'funding' }, { signal: 'x'.repeat(200_000) }] as Record<string, unknown>[])
    assert.equal(isJobPostingClaim(c), false, JSON.stringify(c).slice(0, 60))
  assert.equal(isJobPostingClaim(null), false)
})

test('AC-4: a stored customer hold on a job-posting claim stays research, but its hint never says "customer"', () => {
  const stored = { review_reason: 'counterparty_signal', signal: 'Hiring a front desk receptionist', event_date: '2026-11-01' }
  assert.equal(holdFitsClaim('counterparty_signal', stored), false)
  const a = reviewAction(stored, NOW)
  assert.equal(a.label, 'Keep as research')
  assert.doesNotMatch(a.hint, /customer/i)
  // a non-hiring claim keeps the customer wording
  const b = reviewAction({ ...stored, signal: 'Smile Dental Care switched to Weave' }, NOW)
  assert.equal(b.label, 'Keep as research')
  assert.match(b.hint, /customer/i)
})
