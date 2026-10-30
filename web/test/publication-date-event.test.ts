// #460: an event day counts only when the FETCHED page ties it to THIS company and THIS event. A publication / update stamp (metadata or a visible
// "Published/Posted/Updated <day>" line), another company's announcement or an unrelated conference on the same day, a page with no date at all, and the model's own
// date are all undated research. Valid event-dated pages and genuine structured job-board dates keep working. Synthetic pages only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verifyLeads, type LeadDraft } from '../lib/scan/runner.ts'
import { eventDateBound } from '../lib/scan/event-date-binding.ts'
import type { Page } from '../lib/scan/fetch-page.ts'

const NOW = new Date('2026-10-20T12:00:00Z')
const filler = ' The agency builds brand campaigns for Toronto restaurants and retailers across Ontario.'.repeat(4)
const QUOTE = 'Aurora Agency opened a new office on King Street West in Toronto, ON'
const lead = (event_date: string | null, o: Partial<LeadDraft> = {}): LeadDraft => ({ name: '', company: 'Aurora Agency', contact: null, signal: 'Opened a new office', source_url: 'https://news.example/aurora', score: 70, excerpt: QUOTE, event_date, ...o })
const page = (text: string, published: string | null = null): Page => ({ title: 'Aurora Agency', text, retrievedAt: NOW.getTime(), published })
const run = async (c: LeadDraft, p: Page, dates?: ReadonlyMap<string, string>) => { const o = await verifyLeads([c], async () => p, NOW, undefined, null, undefined, undefined, [], dates); return { lead: o.leads[0], review: o.review[0] } }
const undated = (l: { event_date: string | null; date_status?: string | null }) => { assert.equal(l.event_date, null); assert.equal(l.date_status, 'undated') }

test('negative 1: the fetched page has no date at all, so the model\'s date does not survive', async () => {
  const { lead: l } = await run(lead('2026-10-15'), page(`${QUOTE}.${filler}`))
  assert.ok(l, 'still source-checked'); undated(l)
  assert.match(l.timing_note ?? '', /not tied to this company and event/)
})

test('negative 2: published-only date for Aurora, plus an unrelated company\'s event on that day', async () => {
  const p = page(`Published 2026-10-15. ${QUOTE}. On October 15, 2026, Zenith Corp opened a new office in Ottawa.${filler}`, '2026-10-15')
  undated((await run(lead('2026-10-15'), p)).lead)
})

test('negative 3: published-only date for Aurora, plus an unrelated conference on that day', async () => {
  const p = page(`Published 2026-10-15. ${QUOTE}. The Toronto Marketing Conference runs on October 15, 2026 at the convention centre.${filler}`, '2026-10-15')
  undated((await run(lead('2026-10-15'), p)).lead)
  // even when the conference sentence names Aurora (as an attendee), it is a different event than the quote's
  const attends = page(`Published 2026-10-15. ${QUOTE}. Aurora Agency will attend the Toronto Marketing Conference on October 15, 2026.${filler}`, '2026-10-15')
  undated((await run(lead('2026-10-15'), attends)).lead)
})

test('a publication / update stamp never dates the event: metadata, and every visible form', async () => {
  const meta = page(`${QUOTE}. Archive profile from our directory.${filler}`, '2026-10-15')
  undated((await run(lead('2026-10-15'), meta)).lead); assert.equal((await run(lead('2026-10-15'), meta)).lead.published_at, '2026-10-15')
  for (const stamp of ['Published 2026-10-15', 'Posted October 15, 2026', 'Updated Oct 15, 2026', 'Published 15 October 2026']) {
    const { lead: l } = await run(lead('2026-10-15'), page(`${stamp}. ${QUOTE}.${filler}`))
    undated(l)
    if (!/^Updated/.test(stamp)) assert.equal(l.published_at, '2026-10-15', `${stamp}: kept as a label`)
  }
})

test('valid event-dated pages keep their date: the same sentence as the quote, or a sentence naming the company and the same event', async () => {
  const same = page(`On October 15, 2026, ${QUOTE}.${filler}`, '2026-10-15')
  assert.equal((await run(lead('2026-10-15'), same)).lead.event_date, '2026-10-15')
  const also = page(`Published 2026-10-15. On October 15, 2026, ${QUOTE}.${filler}`)
  assert.equal((await run(lead('2026-10-15'), also)).lead.event_date, '2026-10-15')
  const neighbour = page(`${QUOTE}. Aurora Agency opened its new office to clients on 2026-10-09.${filler}`)
  assert.equal((await run(lead('2026-10-09'), neighbour)).lead.event_date, '2026-10-09')
})

test('structured job-board provenance: a collected posting date for exactly this URL is kept; a board-looking hostname alone is not', async () => {
  const job = lead('2026-10-12', { source_url: 'https://boards.greenhouse.io/aurora/jobs/1', excerpt: 'Aurora Agency is hiring an Account Executive in Toronto, ON' })
  const p = page(`Aurora Agency is hiring an Account Executive in Toronto, ON.${filler}`)
  assert.equal((await run(job, p, new Map([['https://boards.greenhouse.io/aurora/jobs/1', '2026-10-12']]))).lead.event_date, '2026-10-12')
  undated((await run(job, p)).lead)                                                                         // ATS hostname, no collected date
  undated((await run(job, p, new Map([['https://boards.greenhouse.io/aurora/jobs/2', '2026-10-12']]))).lead) // another posting's date
  undated((await run(job, p, new Map([['https://boards.greenhouse.io/aurora/jobs/1', '2026-09-01']]))).lead) // a different day than the claim
})

test('an old year in the quote is still held as stale; a bound date is judged by the window as before', async () => {
  const old = { ...lead('2026-10-15'), excerpt: `${QUOTE} in 2019` }
  const r = await run(old, page(`On October 15, 2026, ${QUOTE} in 2019.${filler}`, '2026-10-15'))
  assert.equal(r.lead, undefined); assert.equal(r.review.review_reason, 'event_date_stale')
})

test('eventDateBound: day found, sentence-bound to company + event; stamps, other companies and other events do not bind', () => {
  const b = (text: string) => eventDateBound('2026-10-15', text, QUOTE, 'Aurora Agency')
  assert.equal(b(`On 15 October 2026, ${QUOTE}.`).bound, true)
  assert.equal(b(`${QUOTE}.`).why, 'the fetched page never states that day')
  assert.equal(b(`Posted 15 October 2026. ${QUOTE}.`).why, 'the day appears only as a publication / update stamp')
  assert.equal(b(`${QUOTE}. Zenith Corp opened a new office on 2026-10-15.`).bound, false)
  assert.equal(b(`${QUOTE}. Aurora Agency sponsors a gala on 2026-10-15.`).bound, false, 'same company, different event')
  assert.equal(b(`2026-10-15. ${QUOTE}.`).bound, false, 'a bare date line before the quote is not a statement about it')
  assert.equal(eventDateBound(null, 'x', QUOTE, 'Aurora Agency').bound, false)
})
