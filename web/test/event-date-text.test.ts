// #460: an event date the page TEXT never states must not make a lead verified-recent. Synthetic pages (invented companies); no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { datesStatedIn, dateStatedInText, hasStructuredPostingDate } from '../lib/scan/date-in-text.ts'
import { verifyLeads } from '../lib/scan/runner.ts'
import { splitByWindow } from '../lib/scan/window.ts'

const NOW = new Date('2026-10-20T12:00:00Z')
const fill = ' The agency serves clients across the city and is listed in our directory of local businesses.'.repeat(4)
const cand = (o: object = {}) => ({ name: '', company: 'Northern Lights Agency', contact: null, signal: 'opened a new office', source_url: 'https://news.example/toronto/northern-lights-profile', score: 70,
  excerpt: 'Northern Lights Agency opened a new office on Queen Street West in Toronto, ON, its third in the city', event_date: '2026-10-15' as string | null, ...o })
const page = (text: string, published?: string) => async () => ({ text: text + fill, title: 'Northern Lights Agency profile', retrievedAt: 1_800_000_000, ...(published ? { published } : {}) })

test('datesStatedIn reads the written forms of a calendar day and nothing else', () => {
  const t = 'Opened 2026-10-08. Also October 9, 2026; Oct. 10th, 2026; 11 October 2026; 12th of October 2026; 13/10/2026; 10/14/2026; 15.10.2026; 2026/10/16.'
  assert.deepEqual([...datesStatedIn(t)].sort(), ['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'])
  for (const bad of ['2026-02-31', 'October 32, 2026', '31/31/2026', 'Posted last week', 'in 2026', 'Oct 2026']) assert.equal(datesStatedIn(bad).size, 0, bad)
  assert.equal(dateStatedInText('2026-10-15', 'Opened on the 15th of this month'), false)
})

test('#460 case: the page only dates itself in metadata (published 2026-10-15), the text never dates the event -> UNDATED, never verified-recent', async () => {
  const r = await verifyLeads([cand()], page('Northern Lights Agency opened a new office on Queen Street West in Toronto, ON, its third in the city. Archive profile, first written for our agency directory.', '2026-10-15'), NOW)
  assert.equal(r.leads.length, 1)
  assert.equal(r.leads[0].event_date, null); assert.equal(r.leads[0].date_status, 'undated')
  assert.match(r.leads[0].timing_note!, /2026-10-15 is not stated in the page text \(it is only the page's publication date\); treated as undated/)
  // Under a 90-day window an undated lead is held as research, never inside it.
  const split = splitByWindow(r.leads, 90, NOW)
  assert.equal(split.inside.length, 0); assert.equal(split.outside.length, 1)
})

test('STRICT mode (DAZL_EVENT_DATE_STRICT=1): a date the extraction supplied that appears nowhere on the page is also undated; the default leaves it as today', async () => {
  const lead = () => verifyLeads([cand({ event_date: '2026-10-12' })], page('Northern Lights Agency opened a new office on Queen Street West in Toronto, ON, its third in the city. Welcome to our directory.'), NOW)
  assert.equal((await lead()).leads[0].event_date, '2026-10-12', 'default: unchanged (the day is not the page publication metadata)')
  process.env.DAZL_EVENT_DATE_STRICT = '1'
  try {
  const r = await lead()
  assert.equal(r.leads[0].event_date, null); assert.equal(r.leads[0].date_status, 'undated'); assert.match(r.leads[0].timing_note!, /not stated in the page text/)
  } finally { delete process.env.DAZL_EVENT_DATE_STRICT }
})

test('control: a date stated in the text still verifies exactly as before - ISO, "October 8, 2026" and "8 October 2026"', async () => {
  for (const [stated, iso] of [['2026-10-08', '2026-10-08'], ['October 8, 2026', '2026-10-08'], ['8 October 2026', '2026-10-08'], ['Oct. 8th, 2026', '2026-10-08']] as const) {
    const r = await verifyLeads([cand({ company: 'Maple Leaf Marketing', excerpt: 'Maple Leaf Marketing opened a new office in Liberty Village, Toronto, ON this month', event_date: iso })],
      page(`${stated}. Maple Leaf Marketing opened a new office in Liberty Village, Toronto, ON this month. Contact: hello@mapleleaf.example.`, '2026-10-15'), NOW)
    assert.equal(r.leads.length, 1, stated); assert.equal(r.leads[0].event_date, iso, stated); assert.equal(r.leads[0].date_status, 'unverified', stated)
  }
})

test('a stated date that differs from the claimed one does not vouch for it (the claimed day is the page metadata; the text states another day)', async () => {
  const r = await verifyLeads([cand({ event_date: '2026-10-15' })], page('2026-10-12. Northern Lights Agency opened a new office on Queen Street West in Toronto, ON, its third in the city.', '2026-10-15'), NOW)
  assert.equal(r.leads[0].event_date, null); assert.equal(r.leads[0].date_status, 'undated')
})

test('a public job-board posting keeps its structured publish date (Greenhouse / Lever / Ashby); other hosts do not', async () => {
  assert.equal(hasStructuredPostingDate('https://boards.greenhouse.io/acme/jobs/1'), true)
  assert.equal(hasStructuredPostingDate('https://jobs.lever.co/acme/abc'), true)
  assert.equal(hasStructuredPostingDate('https://jobs.ashbyhq.com/acme/abc'), true)
  assert.equal(hasStructuredPostingDate('https://acme.com/careers'), false); assert.equal(hasStructuredPostingDate('https://boards.greenhouse.io.evil.example/x'), false)
  const q = 'Northern Lights Agency is hiring an Account Executive in Toronto, ON for its sales team'
  const r = await verifyLeads([cand({ source_url: 'https://jobs.lever.co/northernlights/abc', excerpt: q, event_date: '2026-10-15' })], page(`${q}. Apply now.`), NOW)
  assert.equal(r.leads[0].event_date, '2026-10-15')
})
