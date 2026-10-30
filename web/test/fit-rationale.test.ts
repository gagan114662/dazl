// #377: fit/use-case rationale is kept apart from timing; timing is supported only by verified event-association proof, never a model grade or a copied date.
// Synthetic leads; no network, no key.
import test from 'node:test'
import assert from 'node:assert/strict'
import { scoreLeads } from '../lib/scan/score.ts'
import { fitRationale, timingOf } from '../lib/scan/timing-proof.ts'
import { rankLeads } from '../lib/events/prioritize.ts'

const dated = { company: 'Harbor Dental', name: '', signal: 'opened a second office', excerpt: 'On 2026-10-08, Harbor Dental opened a second office in Brooklyn with six operatories', event_date: '2026-10-08', date_status: 'unverified' as string | null }
const undatedLead = { company: 'Elm Street Dental', name: '', signal: 'opened a second office', excerpt: 'Elm Street Dental opened a second office in Queens with six operatories this month', event_date: '2026-10-08', date_status: 'unverified' as string | null }
const FIT = 'A multi-chair practice with a second site needs online booking across locations, which is what this seller sells.'
const provider = (line: (i: number) => string) => ({ research: async () => ({ text: '', citedUrls: [] }), complete: async () => [1, 2].map(line).join('\n') })

test('timing proof: identity-bound AND the day stated in the verbatim quote; a copied/publication date, a legacy verified flag or a bare model grade never supports it', () => {
  assert.equal(timingOf({ ...dated, confidence: 70 }).supported, true)
  assert.equal(timingOf({ ...undatedLead, confidence: 70 }).supported, false, 'the date is a claim: the quote does not state it')
  assert.equal(timingOf({ ...dated, confidence: 70, date_status: 'verified', excerpt: 'Harbor Dental opened a second office in Brooklyn' }).supported, false, 'a legacy verified label alone proves nothing')
  assert.equal(timingOf({ ...dated, confidence: null }).supported, false, 'not a kept verified lead')
  assert.equal(timingOf({ ...dated, confidence: 70, review_reason: 'quote_unconfirmed' }).supported, false)
  assert.equal(timingOf({ ...dated, confidence: 70, excerpt: 'On 2026-10-08, Maple Dental opened a second office' }).identityBound, false, 'another company is named in the quote')
  assert.equal(timingOf({ ...dated, confidence: 70, window_held: true }).status, 'held')
  assert.equal(timingOf({ ...dated, confidence: 70, event_date: null }).reason, 'No event date: timing is unknown.')
})

test('two equal-fit leads keep their fit rationale; only the one with proof gets a timing grade, and only that one ranks higher', async () => {
  const line = (i: number) => `LEAD ${i} | fit 4 | intent 5 | action 3 | match yyyy | signals expansion | why ${FIT}`
  const g = await scoreLeads(provider(line), 'k', 'ICP', [dated, undatedLead])
  assert.deepEqual(g!.map(x => x.fit), [4, 4]); assert.deepEqual(g!.map(x => x.why), [FIT, FIT], 'the written fit rationale is preserved for both')
  assert.deepEqual(g!.map(x => x.intent), [5, 0], 'intent only where the quote proves the event day'); assert.deepEqual(g!.map(x => x.timing!.status), ['supported', 'unknown'])
  const rows = [{ id: 'u', fit: 4, intent: g![1].intent, action: 3, score: 70 }, { id: 'd', fit: 4, intent: g![0].intent, action: 3, score: 70 }]
  assert.deepEqual(rankLeads(rows as never, {}).map(r => r.id), ['d', 'u'], 'proof makes the difference')
  // Without proof for either, equal fit stays equal: nothing is ranked apart on a model grade.
  const both = await scoreLeads(provider(line), 'k', 'ICP', [undatedLead, { ...undatedLead, company: 'Oak Dental', excerpt: 'Oak Dental opened a second office this month' }])
  assert.deepEqual(both!.map(x => x.intent), [0, 0])
})

test('unsupported timing claims are removed from the rationale, never the fit reasoning; supported timing keeps the whole text', () => {
  assert.equal(fitRationale(`${FIT} They need this right now because they are expanding.`, false), FIT)
  assert.equal(fitRationale('Urgent need right now.', false), 'Fit rationale not written for this lead. Event timing is unconfirmed.')
  assert.equal(fitRationale(`${FIT} They need this right now.`, true), `${FIT} They need this right now.`)
})
