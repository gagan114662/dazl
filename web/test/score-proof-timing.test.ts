// #377: proof-backed timing consumption in scoreLeads. DRAFT prepared pre-implementation against the
// locked contract: event_date_proof is a closed set (NULL | 'page_bound' | 'ats_structured'); model
// intent ranks only with a recognized proof compatible with the lead's trigger AND event_date inside
// the request window; otherwise intent is held at 0 and the timing status is APPENDED to why, never
// replacing the model's fit rationale. No publication/model date alone can upgrade timing.
import test from 'node:test'
import assert from 'node:assert/strict'
import { scoreLeads, TIMING_UNCONFIRMED_NOTE } from '../lib/scan/score.ts'
import type { Provider } from '../lib/llm/provider.ts'

const WHY_FIT = 'Strong fit: dental clinic group expanding into the seller\'s market.'
// The model grades every lead identically: fit 5, intent 4, same rationale. One LEAD line per input.
const grade = (n: number) => Array.from({ length: n }, (_, i) => `LEAD ${i + 1} | fit 5 | intent 4 | action 3 | match yyyn | signals expansion | why ${WHY_FIT}`).join('\n')
const providerFor = (n: number): Provider => ({ complete: async () => grade(n) }) as unknown as Provider

const base = { company: 'Acme Dental', name: '', signal: 'opening a new location', excerpt: 'Acme Dental said it will open a second clinic in Toronto next month' }

test('proof-backed bound event inside the window keeps the model intent; unproven timing is held at 0 with why preserved', async () => {
  const out = await scoreLeads(providerFor(2), 'k', 'icp text', [
    { ...base, event_date: '2026-10-20', event_date_proof: 'page_bound' },
    { ...base, event_date: '2026-10-20', event_date_proof: null },
  ], undefined, { windowDays: 90, now: new Date('2026-10-26T12:00:00Z') })
  assert.ok(out)
  const [proven, unproven] = out!
  assert.equal(proven.fit, 5)
  assert.equal(proven.intent, 4, 'recognized page_bound proof inside the window keeps the model intent')
  assert.equal(proven.why, WHY_FIT, 'fit rationale untouched when timing is proven')
  assert.equal(unproven.intent, 0, 'missing proof holds intent at 0')
  assert.ok(unproven.why.startsWith(WHY_FIT), 'fit rationale is preserved, not overwritten')
  assert.ok(unproven.why.includes(TIMING_UNCONFIRMED_NOTE), 'timing status is appended')
})

test('ats_structured supports only a hiring trigger; a funding or other trigger is held', async () => {
  const hiring = { ...base, signal: 'hiring a sales rep', event_date: '2026-10-20', event_date_proof: 'ats_structured' as const }
  const funding = { ...base, signal: 'raised seed funding', event_date: '2026-10-20', event_date_proof: 'ats_structured' as const }
  const out = await scoreLeads(providerFor(2), 'k', 'icp', [hiring, funding], undefined, { windowDays: 90, now: new Date('2026-10-26T12:00:00Z') })
  assert.equal(out![0].intent, 4, 'ATS posting date is the posting event: valid for a hiring trigger')
  assert.equal(out![1].intent, 0, 'an ATS publish stamp is not a funding-event date')
})

test('unrecognized proof states and dates outside the requested window fail closed', async () => {
  const out = await scoreLeads(providerFor(3), 'k', 'icp', [
    { ...base, event_date: '2026-10-20', event_date_proof: 'structured_same_event' }, // retired vocabulary: unrecognized
    { ...base, event_date: '2026-01-15', event_date_proof: 'page_bound' },            // bound but outside a 30-day window
    { ...base, event_date: '2027-02-01', event_date_proof: 'page_bound' },            // future date beyond tolerance
  ], undefined, { windowDays: 30, now: new Date('2026-10-26T12:00:00Z') })
  assert.deepEqual(out!.map(l => l.intent), [0, 0, 0])
  for (const l of out!) assert.ok(l.why.startsWith(WHY_FIT) && l.why.includes(TIMING_UNCONFIRMED_NOTE))
})

test('a publication or model date alone never upgrades timing', async () => {
  const out = await scoreLeads(providerFor(1), 'k', 'icp', [
    { ...base, event_date: null, date_status: 'unverified' }, // post-scan structured read without proof
  ], undefined, { windowDays: 90, now: new Date('2026-10-26T12:00:00Z') })
  assert.equal(out![0].intent, 0)
})

test('strict no-future boundary pinned: today passes, even one day ahead fails', async () => {
  const now = new Date('2026-10-26T12:00:00Z')
  const out = await scoreLeads(providerFor(3), 'k', 'icp', [
    { ...base, event_date: '2026-10-26', event_date_proof: 'page_bound' }, // age 0: today
    { ...base, event_date: '2026-10-27', event_date_proof: 'page_bound' }, // age < 0: future, never a valid event date
    { ...base, event_date: '2026-10-28', event_date_proof: 'page_bound' },
  ], undefined, { windowDays: 90, now })
  assert.deepEqual(out!.map(l => l.intent), [4, 0, 0],
    'predicate: recognized proof AND valid calendar day AND age >= 0 (strict no-future, UTC day contract) AND inside the window when one was requested')
})

test('windowless request: no invented window gate - recognized non-future proof keeps the intent grade', async () => {
  const out = await scoreLeads(providerFor(2), 'k', 'icp', [
    { ...base, event_date: '2026-10-20', event_date_proof: 'page_bound' },
    { ...base, event_date: '2026-10-20', event_date_proof: null },
  ], undefined, { now: new Date('2026-10-26T12:00:00Z') }) // no windowDays supplied
  assert.equal(out![0].intent, 4, 'no window was requested, so none is invented; proof + non-future is enough')
  assert.equal(out![1].intent, 0, 'proof is still required')
  assert.ok(out![1].why.startsWith(WHY_FIT) && out![1].why.includes(TIMING_UNCONFIRMED_NOTE))
})
