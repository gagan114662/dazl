import { test } from 'node:test'
import assert from 'node:assert/strict'
import { publishedDate, htmlToText } from '../lib/scan/fetch-page.ts'

test('publication metadata: JSON-LD datePosted/datePublished, article:published_time and <time pubdate> are read; modified/updated stamps never are', () => {
  assert.equal(publishedDate('<script type="application/ld+json">{"@type":"JobPosting","datePosted":"2026-10-05T09:00:00Z"}</script>'), '2026-10-05')
  assert.equal(publishedDate('<meta property="article:published_time" content="2026-09-30T12:00:00-04:00">'), '2026-09-30')
  assert.equal(publishedDate('<meta content="2026-09-01" name="pubdate">'), '2026-09-01')
  assert.equal(publishedDate('<time datetime="2026-08-20" pubdate>Aug 20</time>'), '2026-08-20')
  assert.equal(publishedDate('<meta property="article:modified_time" content="2026-10-20"><meta property="og:updated_time" content="2026-10-21"><script>{"dateModified":"2026-10-22"}</script>'), null)
  assert.equal(publishedDate('<meta property="article:published_time" content="2026-13-45">'), null, 'invalid calendar date')
  assert.equal(htmlToText('<html><head><title>T</title><meta property="article:published_time" content="2026-10-05"></head><body>Hello world</body></html>').published, '2026-10-05')
})
test('a news list / multi-article page / unrelated JSON-LD entity beside the page\'s own: two different publication days -> none is reported', () => {
  assert.equal(publishedDate('<script type="application/ld+json">{"@type":"NewsArticle","datePublished":"2026-10-01"}</script><script type="application/ld+json">{"@type":"NewsArticle","datePublished":"2026-09-12"}</script>'), null)
  assert.equal(publishedDate('<meta property="article:published_time" content="2026-10-20"><script type="application/ld+json">{"@type":"Review","datePublished":"2019-02-03"}</script>'), null)
  assert.equal(publishedDate('<meta property="article:published_time" content="2026-10-20"><time datetime="2026-10-20" pubdate></time>'), '2026-10-20', 'the same day twice is still one day')
})
