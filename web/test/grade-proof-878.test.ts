// #878 / #1176: the grading prompt told the model the retired date_status, so a lead whose day is PROVEN on its cited source was graded as unverified timing.
// REAL rows: Zayed Law (prod play b10654425e8246c915e355b9: event_date 2026-10-06, event_date_proof page_bound, date_status 'unverified') and UBE Marketing
// (matrix:local sydney-agencies on 0adabc18, 2026-11-15: event_date 2026-10-21 from its own post, proof page_bound, date_status 'undated'; graded intent 0 with
// "No timing for the claimed October 2026 publication is verified in the evidence"). Signals and quotes are the stored ones, shortened.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { eventAssociation, scoreLeads, scorePrompt } from '../lib/scan/score.ts'
const NOW = new Date('2026-11-15T12:00:00Z')
const ZAYED = { company: 'Zayed Law', name: '', signal: 'Significantly expanded its Chicago office', excerpt: 'Zayed Law significantly expands Chicago office', event_date: '2026-10-06', date_status: 'unverified', event_date_proof: 'page_bound', signal_kind: null }
const UBE = { company: 'UBE Marketing', name: 'Alvin Paronda', signal: 'Founder of Sydney B2B marketing agency published content in October 2026', excerpt: 'Alvin Paronda is the Founder & CEO of UBE Marketing, a Sydney marketing agency for B2B and Microsoft partners.', event_date: '2026-10-21', date_status: 'undated', event_date_proof: 'page_bound', signal_kind: null }

test('#878 a lead whose day is proven on its cited source is shown to the grader as verified (the real Zayed Law and UBE Marketing rows)', () => {
  const p = scorePrompt('ICP', [ZAYED, UBE], NOW)
  assert.equal((p.match(/event association: verified \(the cited source states this day for this company and event\)/g) ?? []).length, 2, p.slice(-900))
  assert.doesNotMatch(p, /event association: (?:unverified|undated)/)
})

test('#878 controls: no proof, a retired "verified" without a proof, a board date on a non-hiring claim, a future day: never shown as verified', () => {
  assert.equal(eventAssociation({ ...ZAYED, event_date_proof: null }, NOW), 'unverified')
  assert.equal(eventAssociation({ ...ZAYED, event_date_proof: null, date_status: 'verified' }, NOW), 'unverified', 'the retired value alone proves nothing (#1176)')
  assert.equal(eventAssociation({ ...UBE, event_date_proof: null }, NOW), 'undated')
  assert.equal(eventAssociation({ ...ZAYED, event_date: null }, NOW), 'unverified')
  assert.equal(eventAssociation({ ...ZAYED, event_date_proof: 'ats_structured' }, NOW), 'unverified', 'a job board date proves only a hiring claim')
  assert.match(eventAssociation({ ...ZAYED, event_date_proof: 'ats_structured', signal: 'Hiring a paralegal', signal_kind: 'hiring' }, NOW), /^verified/)
  assert.equal(eventAssociation({ ...ZAYED, event_date: '2026-12-01' }, NOW), 'unverified', 'a day in the future is not proven')
  assert.equal(eventAssociation({ date_status: null }, NOW), 'unknown')
})

test('#878 the grade: a model that reads the proven day keeps its intent (inside the window); the same answer for an unproven day is still held at 0', async () => {
  const provider = { research: async () => ({ text: '', citedUrls: [] }), complete: async () => 'LEAD 1 | fit 4 | intent 3 | action 3 | match yy?y | signals none | why Expanded its Chicago office this autumn.' } as never
  const proven = await scoreLeads(provider, 'k', 'ICP', [ZAYED], undefined, { windowDays: 90, now: NOW })
  assert.equal(proven?.[0].intent, 3); assert.doesNotMatch(proven?.[0].why ?? '', /unconfirmed/)
  const unproven = await scoreLeads(provider, 'k', 'ICP', [{ ...ZAYED, event_date_proof: null }], undefined, { windowDays: 90, now: NOW })
  assert.equal(unproven?.[0].intent, 0, 'unchanged: the deterministic hold for a day without proof (#377)')
})

// Independent review (sonnet, APPROVE 8/10) nits, pinned:
test('#878 (review) a proven day OUTSIDE the window: the model may read it as verified, but the stored grade is still held at intent 0 with the timing note', async () => {
  const stale = { ...ZAYED, event_date: '2026-04-01' }   // proven, 228 days before NOW, window 90
  assert.match(eventAssociation(stale, NOW), /^verified/, 'the day itself is proven')
  const provider = { research: async () => ({ text: '', citedUrls: [] }), complete: async () => 'LEAD 1 | fit 4 | intent 4 | action 3 | match yy?y | signals none | why Expanded its Chicago office.' } as never
  const g = await scoreLeads(provider, 'k', 'ICP', [stale], undefined, { windowDays: 90, now: NOW })
  assert.equal(g?.[0].intent, 0); assert.match(g?.[0].why ?? '', /Event timing is unconfirmed/)
})
test('#878 (review) an impossible calendar day or an unknown proof value is never shown as verified', () => {
  assert.equal(eventAssociation({ ...ZAYED, event_date: '2026-02-30' }, NOW), 'unverified')
  assert.equal(eventAssociation({ ...ZAYED, event_date_proof: 'model_said_so' }, NOW), 'unverified')
})
