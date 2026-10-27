import { test } from 'node:test'
import assert from 'node:assert/strict'
import { publishedDate, htmlToText } from '../lib/scan/fetch-page.ts'
import { resolveTiming } from '../lib/scan/page-timing.ts'
import { verifyLeads } from '../lib/scan/runner.ts'

test('publication metadata: JSON-LD datePosted/datePublished, article:published_time and <time pubdate> are read; modified/updated stamps never are', () => {
  assert.equal(publishedDate('<script type="application/ld+json">{"@type":"JobPosting","datePosted":"2026-10-05T09:00:00Z"}</script>'), '2026-10-05')
  assert.equal(publishedDate('<meta property="article:published_time" content="2026-09-30T12:00:00-04:00">'), '2026-09-30')
  assert.equal(publishedDate('<meta content="2026-09-01" name="pubdate">'), '2026-09-01')
  assert.equal(publishedDate('<time datetime="2026-08-20" pubdate>Aug 20</time>'), '2026-08-20')
  assert.equal(publishedDate('<meta property="article:modified_time" content="2026-10-20"><meta property="og:updated_time" content="2026-10-21"><script>{"dateModified":"2026-10-22"}</script>'), null)
  assert.equal(publishedDate('<meta property="article:published_time" content="2026-13-45">'), null, 'invalid calendar date')
  assert.equal(htmlToText('<html><head><title>T</title><meta property="article:published_time" content="2026-10-05"></head><body>Hello world</body></html>').published, '2026-10-05')
})
test('the page\'s own publication date dates an undated candidate (same stale / future / window rules afterwards)', async () => {
  assert.equal(resolveTiming('no date in the prose at all', 'no date in the prose', '2026-10-05').date, '2026-10-05')
  const Q = 'Smile Studio is hiring a front desk receptionist for its Manhattan office'
  const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
  const cand = { name: '', company: 'Smile Studio', contact: null, signal: 'receptionist job', source_url: 'https://jobs.example/s', score: 70, excerpt: Q, event_date: null as string | null }
  const mk = (published: string | null) => async () => ({ text: `${Q}. ${'The practice welcomes families. '.repeat(10)}`, title: 'Receptionist - Smile Studio', retrievedAt: 1, ...(published ? { published } : {}) })
  const ok = await verifyLeads([cand], mk(day(8))); assert.equal(ok.leads.length, 1); assert.equal(ok.leads[0].event_date, day(8)); assert.match(ok.leads[0].timing_note!, /publication metadata/)
  const stale = await verifyLeads([cand], mk('2019-05-05')); assert.equal(stale.leads.length, 0); assert.equal(stale.review[0].review_reason, 'event_date_stale')
  const none = await verifyLeads([cand], mk(null)); assert.equal(none.leads[0].event_date, null, 'no metadata and no prose date: stays undated, nothing invented')
})
