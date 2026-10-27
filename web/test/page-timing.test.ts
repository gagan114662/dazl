// Timing resolution from already-fetched page text. Pure functions and stubbed runs; pages are INVENTED.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveTiming } from '../lib/scan/page-timing.ts'
import { verifyLeads } from '../lib/scan/runner.ts'

const Q = 'Dent Blanche is opening a second Manhattan location on West 57th Street'
test('a cued publication date near the quote is read; the nearest wins; update/last-modified stamps are not event dates', () => {
  assert.equal(resolveTiming(`Posted October 17, 2026. ${Q}.`, Q).date, '2026-10-17')
  assert.equal(resolveTiming(`News. ${Q}. Published 2026-09-02`, Q).date, '2026-09-02')
  assert.equal(resolveTiming(`Oct 3, 2026 - ${Q}.`, Q).date, '2026-10-03', 'dateline right before the quote')
  assert.equal(resolveTiming(`Page last updated 2026-10-20. ${Q}. ${'x '.repeat(400)}`, Q).date, null)
  assert.equal(resolveTiming(`Copyright 2024. ${Q}. ${'x '.repeat(400)} Posted 2019-01-01 in the archive`, Q).date, null, 'a cued date far from the quote and the page head is ignored')
  assert.equal(resolveTiming(`Posted 2026-13-45. ${Q}.`, Q).date, null, 'invalid calendar dates are ignored')
})
test('a season or "soon" is only a label, never a date', () => {
  const t = resolveTiming(`${Q} this fall, with a ribbon cutting to be announced.`, Q)
  assert.equal(t.date, null); assert.match(t.note!, /^timing: fall, unconfirmed/)
  assert.match(resolveTiming(`${Q} - opening soon.`, Q).note!, /"soon", unconfirmed/)
  assert.deepEqual(resolveTiming(`${Q}.`, Q), { date: null, note: null })
})
const pad = (s: string) => `${s} ${'The practice serves families across the borough. '.repeat(8)}`
const cand = (over: object = {}) => ({ name: '', company: 'Dent Blanche', contact: null, signal: 'second location', source_url: 'https://news.example/db', score: 70, excerpt: Q, event_date: null as string | null, ...over })
const page = (text: string) => async () => ({ text: pad(text), title: 'Dent Blanche expands', retrievedAt: 1_700_000_000 })
const dayStr = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
test('verifier: an undated candidate whose page carries a cued date is dated, labelled, and judged by the SAME rules (fresh = verified-as-unverified-date; stale = review)', async () => {
  const fresh = await verifyLeads([cand()], page(`Posted ${dayStr(12)}. ${Q}.`))
  assert.equal(fresh.leads.length, 1); assert.equal(fresh.leads[0].event_date, dayStr(12)); assert.equal(fresh.leads[0].date_status, 'unverified'); assert.match(fresh.leads[0].timing_note!, /date read from the page text/)
  const stale = await verifyLeads([cand()], page(`Posted 2019-03-04. ${Q}.`))
  assert.equal(stale.leads.length, 0); assert.equal(stale.review[0].review_reason, 'event_date_stale')
  const future = await verifyLeads([cand()], page(`Posted 2099-03-04. ${Q}.`))
  assert.equal(future.leads.length, 0, 'a future date never qualifies')
})
test('verifier: a season-only page stays undated (no invented date) but carries the researched-timing label; a model-supplied date is never overwritten', async () => {
  const s = await verifyLeads([cand()], page(`${Q} this fall.`))
  assert.equal(s.leads.length, 1); assert.equal(s.leads[0].event_date, null); assert.equal(s.leads[0].date_status, 'undated'); assert.match(s.leads[0].timing_note!, /timing: fall, unconfirmed/)
  const given = await verifyLeads([cand({ event_date: dayStr(5) })], page(`Posted ${dayStr(40)}. ${Q}.`))
  assert.equal(given.leads[0].event_date, dayStr(5)); assert.equal(given.leads[0].timing_note ?? null, null)
})
