// #460: an event dated only by the page's publication metadata is not a dated event. The extraction can copy a page's
// publication metadata into event_date; verifyLeads must treat that candidate as undated - the publication day
// stays a label - so the window gate holds it. A day the text itself states for the event keeps working. Synthetic pages only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verifyLeads, type LeadDraft } from '../lib/scan/runner.ts'
import { datedOnlyByPublication, textStatesDay } from '../lib/scan/page-timing.ts'
import type { Page } from '../lib/scan/fetch-page.ts'

const NOW = new Date('2026-10-20T12:00:00Z')
const filler = ' The agency builds brand campaigns for Toronto restaurants and retailers across Ontario.'.repeat(4)
const lead = (event_date: string | null): LeadDraft => ({ name: '', company: 'Aurora Agency', contact: null, signal: 'Opened a new office', source_url: 'https://news.example/aurora', score: 70, excerpt: 'Aurora Agency opened a new office on King Street West in Toronto, ON', event_date })
const page = (text: string, published: string | null = null): Page => ({ title: 'Aurora Agency', text, retrievedAt: NOW.getTime(), published })
const run = async (c: LeadDraft, p: Page) => { const o = await verifyLeads([c], async () => p, NOW); return { lead: o.leads[0], review: o.review[0] } }

test('#460: an event date that equals the publication metadata, never stated in the text, is dropped (published_at stays a label)', async () => {
  const p = page(`Aurora Agency opened a new office on King Street West in Toronto, ON. Archive profile from our directory.${filler}`, '2026-10-15')
  const { lead: l } = await run(lead('2026-10-15'), p)
  assert.ok(l, 'still source-checked: the quote, company and page are fine')
  assert.equal(l.event_date, null)                     // before the fix: '2026-10-15' (the publication day as the event date)
  assert.equal(l.date_status, 'undated')
  assert.equal(l.published_at, '2026-10-15')
  assert.match(l.timing_note ?? '', /publication date only/)
})

test('#460: a "Posted/Updated <day>" stamp in the text does not count as the text stating the event day', async () => {
  for (const stamp of ['Posted 2026-10-15', 'Published October 15, 2026', 'Updated Oct 15, 2026', 'Posted 15 October 2026']) {
    const p = page(`${stamp}. Aurora Agency opened a new office on King Street West in Toronto, ON.${filler}`, '2026-10-15')
    const { lead: l } = await run(lead('2026-10-15'), p)
    assert.equal(l.event_date, null, stamp)
  }
})

test('#460 scope: a cued "Published <day>" line WITHOUT publication metadata is unchanged here (a separate, recorded decision)', async () => {
  const p = page(`Published 2026-10-15. Aurora Agency opened a new office on King Street West in Toronto, ON.${filler}`)
  assert.equal((await run(lead('2026-10-15'), p)).lead.event_date, '2026-10-15')
})

test('#460 controls: a day the text states for the event, or a date that is not the publication day, is kept unchanged', async () => {
  // the text dates the event itself, on the publication day
  const sameDay = page(`On October 15, 2026, Aurora Agency opened a new office on King Street West in Toronto, ON.${filler}`, '2026-10-15')
  assert.equal((await run(lead('2026-10-15'), sameDay)).lead.event_date, '2026-10-15')
  // a different event date from the publication day: not this rule's business (the window gate judges it as before)
  const other = page(`2026-10-09. Aurora Agency opened a new office on King Street West in Toronto, ON.${filler}`, '2026-10-15')
  assert.equal((await run(lead('2026-10-09'), other)).lead.event_date, '2026-10-09')
  // no publication date at all: unchanged
  const none = page(`Aurora Agency opened a new office on King Street West in Toronto, ON.${filler}`)
  assert.equal((await run(lead('2026-10-15'), none)).lead.event_date, '2026-10-15')
  // an old year in the quote is still held as stale, as before
  const old = { ...lead('2026-10-15'), excerpt: 'Aurora Agency opened a new office on King Street West in Toronto, ON in 2019' }
  const r = await run(old, page(`Aurora Agency opened a new office on King Street West in Toronto, ON in 2019.${filler}`, '2026-10-15'))
  assert.equal(r.lead, undefined); assert.equal(r.review.review_reason, 'event_date_stale')
})

test('textStatesDay / datedOnlyByPublication: whole dates only; publication and update stamps do not count', () => {
  assert.equal(textStatesDay('It opened on 15 October 2026.', '2026-10-15'), true)
  assert.equal(textStatesDay('Posted 15 October 2026. It opened.', '2026-10-15'), false)
  assert.equal(textStatesDay('Updated 2026-10-15. It opened.', '2026-10-15'), false)
  assert.equal(textStatesDay('Ref 2026-10-150. It opened.', '2026-10-15'), false)
  assert.equal(textStatesDay('It opened on 18 October 2026.', '2026-10-15'), false)
  assert.equal(datedOnlyByPublication(null, 'x', '2026-10-15'), false)
  assert.equal(datedOnlyByPublication('2026-10-15', 'It opened.', '2026-10-15'), true)
  assert.equal(datedOnlyByPublication('2026-10-15', 'It opened.', null), false)
  assert.equal(datedOnlyByPublication('2026-10-15', 'It opened on 15 October 2026.', '2026-10-15'), false)
})
