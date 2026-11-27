import assert from 'node:assert/strict'
import test from 'node:test'
import { discoverApprove, discoverState } from '../lib/discover/card.ts'

test('a verified date is acknowledged while the rest of the source proof awaits review', () => {
  const lead = {
    source_kind: 'discover',
    event_date: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
    date_status: 'verified',
    event_date_proof: 'page_bound',
    review_reason: 'source_review_required',
    company_domain: 'orchard.example',
    enrichments: [
      { connector: 'discover', kind: 'person', value: 'Eli Ward, Owner', label: 'named on a public page', source_url: 'https://orchard.example/team' },
      { connector: 'discover', kind: 'email', value: 'eli@orchard.example', label: 'email verified on source page', source_url: 'https://orchard.example/team' },
    ],
  }
  assert.equal(discoverState(lead), 'review')
  assert.deepEqual(discoverApprove(lead), {
    ok: false,
    reason: 'The signal date is verified, but the rest of the proof still needs checking. Open the cited source under Needs your review.',
  })

  const complete = { ...lead, review_reason: null }
  assert.deepEqual(discoverApprove(complete), { ok: true })
  assert.equal(discoverState(complete), 'ready_email')

  const pageDateOnly = { ...lead, event_date_proof: null }
  assert.equal(discoverState(pageDateOnly), 'review')
  assert.deepEqual(discoverApprove(pageDateOnly), {
    ok: false,
    reason: "dazl could not confirm this lead's proof page. Check the source under Needs your review first.",
  })

  const unverified = { ...pageDateOnly, date_status: 'unverified' }
  const refusal = discoverApprove(unverified)
  assert.equal(refusal.ok, false)
  if (!refusal.ok) assert.doesNotMatch(refusal.reason, /date is verified/)
})
