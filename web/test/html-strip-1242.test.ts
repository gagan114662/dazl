import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stripTags, dropBlocks, dropComments } from '../lib/html/strip.ts'
import { flatForTest } from '../lib/signals/careers-page.ts'
import { contactContext } from '../lib/outreach/contact-context.ts'

// #1242: /<[^>]+>/g and /<(script|style)[\s\S]*?<\/\1>/gi backtrack quadratically on unclosed tags (22-53 s on 800 KB of "<script ").
// The linear helpers keep the same output on normal HTML and finish hostile 800 KB input fast.
const HOSTILE = '<script '.repeat(100_000) // 800 KB, no '>' and no closing tag
const fast = (label: string, fn: () => unknown, ms = 500) => { const t = performance.now(); fn(); const took = performance.now() - t; assert.ok(took < ms, `${label} took ${took.toFixed(0)} ms`) }

test('stripTags matches the old regex on normal html', () => {
  for (const s of ['<p>Hi <b>there</b></p>', 'a < b and c > d', 'no tags', '<a href="x">link</a> tail <unclosed', '<>empty<>']) assert.equal(stripTags(s), s.replace(/<[^>]+>/g, ' '))
})
test('dropBlocks matches the old regex on normal html', () => {
  for (const s of ['a<script>x</script>b<STYLE x>y</style>c', '<noscript>n</noscript><svg><path/></svg>t', '<script>open forever', 'x<scripts>y</scripts>z']) assert.equal(dropBlocks(s, ['script', 'style', 'noscript', 'svg']), s.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' '))
  assert.equal(dropComments('a<!-- c -->b<!-- open'), 'a<!-- c -->b<!-- open'.replace(/<!--[\s\S]*?-->/g, ' '))
})
test('hostile 800 KB input is linear in every helper and caller', () => {
  fast('stripTags', () => stripTags(HOSTILE))
  fast('dropBlocks', () => dropBlocks(HOSTILE, ['script', 'style']))
  fast('dropComments', () => dropComments('<!--'.repeat(200_000)))
  fast('careers flat', () => flatForTest(HOSTILE))
  fast('contactContext', () => contactContext(HOSTILE, 'a@b.co', 'https://x.co'))
})
import { htmlToText } from '../lib/scan/fetch-page.ts'
import { extractSiteFacts } from '../lib/scan/icp-from-site.ts'
test('fetch-page and icp-from-site readers are linear on hostile input and keep normal text', () => {
  fast('htmlToText', () => htmlToText(HOSTILE)); fast('extractSiteFacts', () => extractSiteFacts(HOSTILE))
  assert.equal(htmlToText('<p>Hello <b>world</b></p><script>x()</script><!-- c -->').text, 'Hello world')
})
