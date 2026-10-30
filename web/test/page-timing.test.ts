// What the fetched page says about WHEN is a label, never the event date. Pure functions and stubbed runs; pages are INVENTED.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveTiming } from '../lib/scan/page-timing.ts'
import { verifyLeads } from '../lib/scan/runner.ts'

const Q = 'Dent Blanche is opening a second Manhattan location on West 57th Street'
const NOW_Y = new Date().getFullYear()
test('a cued publication day near the quote is READ as a publication label; update/last-modified/copyright stamps and uncued dates are not', () => {
  assert.equal(resolveTiming(`Posted October 17, 2026. ${Q}.`, Q, null, NOW_Y).published, '2026-10-17')
  assert.equal(resolveTiming(`News. ${Q}. Published 2026-09-02`, Q, null, NOW_Y).published, '2026-09-02')
  assert.equal(resolveTiming(`Page last updated 2026-10-20. ${Q}. ${'x '.repeat(400)}`, Q, null, NOW_Y).published, null)
  assert.equal(resolveTiming(`Oct 3, 2026 - ${Q}.`, Q, null, NOW_Y).published, null, 'an uncued dateline is not trusted as a publication day')
  assert.equal(resolveTiming(`Posted 2026-13-45. ${Q}.`, Q, null, NOW_Y).published, null)
  assert.match(resolveTiming(`Posted 2026-10-17. ${Q}.`, Q, null, NOW_Y).note!, /publication date only - the event date is unknown/)
})
test('several different publication days on one page (a list of items) belong to none of them', () => {
  const list = `Posted 2026-10-01. Article one. Posted 2026-09-12. ${Q}. Posted 2026-08-30. Article three.`
  assert.equal(resolveTiming(list, Q, null, NOW_Y).published, null)
})
test('a past year named in the QUOTE makes the claim old, whatever the page date; last year alone is left to the window gate', () => {
  assert.equal(resolveTiming('x', 'Smile Studio opened its Manhattan dental office in 2019 and has served families since', '2026-10-20', 2026).olderYear, 2019)
  assert.equal(resolveTiming('x', 'Smile Studio opened in 2025', null, 2026).olderYear, null)
  assert.equal(resolveTiming('x', 'In 2019 Nimbus raised a seed round and has grown since', null, 2026).olderYear, 2019)
})
test('a season or "soon" is only a label, never a date', () => {
  const t = resolveTiming(`${Q} this fall, with a ribbon cutting to be announced.`, Q, null, NOW_Y)
  assert.equal(t.published, null); assert.match(t.note!, /timing: fall, unconfirmed/)
  assert.match(resolveTiming(`${Q} - opening soon.`, Q, null, NOW_Y).note!, /"soon", unconfirmed/)
  assert.deepEqual(resolveTiming(`${Q}.`, Q, null, NOW_Y), { published: null, olderYear: null, note: null })
})
const pad = (s: string) => `${s} ${'The practice serves families across the borough. '.repeat(8)}`
const cand = (over: object = {}) => ({ name: '', company: 'Dent Blanche', contact: null, signal: 'second location', source_url: 'https://news.example/db', score: 70, excerpt: Q, event_date: null as string | null, ...over })
const page = (text: string, published?: string) => async () => ({ text: pad(text), title: 'Dent Blanche expands', retrievedAt: 1_700_000_000, ...(published ? { published } : {}) })
const dayStr = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
test('verifier: a publication day is stored apart from the event date; the candidate stays UNDATED (event_date null), never in-window by that day', async () => {
  const r = await verifyLeads([cand()], page(`${Q}.`, dayStr(12)))
  assert.equal(r.leads[0].event_date, null); assert.equal(r.leads[0].date_status, 'undated'); assert.equal(r.leads[0].published_at, dayStr(12)); assert.match(r.leads[0].timing_note!, /publication date only/)
  const prose = await verifyLeads([cand()], page(`Posted ${dayStr(12)}. ${Q}.`))
  assert.equal(prose.leads[0].event_date, null); assert.equal(prose.leads[0].published_at, dayStr(12))
})
test('verifier: the quote naming a past year goes to review as event_date_stale even though the page was published this month', async () => {
  const old = 'Smile Studio opened its Manhattan dental office in 2019 and has served local families since then'
  const r = await verifyLeads([cand({ company: 'Smile Studio', excerpt: old })], page(`${old}.`, dayStr(7)))
  assert.equal(r.leads.length, 0); assert.equal(r.review[0].review_reason, 'event_date_stale'); assert.match(r.review[0].timing_note!, /names 2019/)
})
test('verifier: a season-only page stays undated with the researched-timing label; a model-supplied date is never overwritten', async () => {
  const s = await verifyLeads([cand()], page(`${Q} this fall.`))
  assert.equal(s.leads[0].event_date, null); assert.equal(s.leads[0].date_status, 'undated'); assert.match(s.leads[0].timing_note!, /timing: fall, unconfirmed/)
  // A model-supplied date is kept (never overwritten by the publication label) when the fetched page states it; one the page never states is undated.
  const given = await verifyLeads([cand({ event_date: dayStr(5) })], page(`Posted ${dayStr(40)}. Opened ${dayStr(5)}. ${Q}.`))
  assert.equal(given.leads[0].event_date, dayStr(5)); assert.equal(given.leads[0].timing_note ?? null, null)
  const unstated = await verifyLeads([cand({ event_date: dayStr(5) })], page(`Posted ${dayStr(40)}. ${Q}.`))
  assert.equal(unstated.leads[0].event_date, null); assert.match(unstated.leads[0].timing_note!, /not stated in the page text/)
})
