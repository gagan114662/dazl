import test from 'node:test'
import assert from 'node:assert/strict'
import { parseReddit, parseX, parseBilibili, parseInstagram } from '../src/fetchers.ts'

test('reddit: posts map to items with permalink, quote and date', () => {
  const raw = { data: { children: [
    { data: { permalink: '/r/startups/comments/abc123/acme_raises/', title: 'Acme raises seed round', selftext: 'Acme Robotics just raised a seed round to hire its first sales team in Europe.', created_utc: 1760000000 } },
    { data: { permalink: '/r/x/comments/bad/short/', title: 'short', selftext: '', created_utc: 1760000000 } },
  ] } }
  const items = parseReddit(raw)
  assert.equal(items.length, 1)
  assert.equal(items[0].url, 'https://www.reddit.com/r/startups/comments/abc123/acme_raises/')
  assert.equal(items[0].date, '2025-10-09')
  assert.ok(items[0].quote.includes('seed round'))
})

test('x: tweets are found anywhere in the graphql payload, deduped', () => {
  const tweet = (id: string, text: string) => ({
    content: { itemContent: { tweet_results: { result: {
      legacy: { id_str: id, full_text: text, created_at: 'Mon Oct 12 10:00:00 +0000 2026' },
      core: { user_results: { result: { legacy: { screen_name: 'betalabs' } } } },
    } } } },
  })
  const raw = { data: { search_by_raw_query: { search_timeline: { timeline: { instructions: [{ entries: [
    tweet('111', 'We are hiring our first sales engineer at Beta Labs, remote ok'),
    tweet('111', 'duplicate tweet id should be dropped here ok'),
  ] }] } } } } }
  const items = parseX(raw)
  assert.equal(items.length, 1)
  assert.equal(items[0].url, 'https://x.com/betalabs/status/111')
  assert.equal(items[0].date, '2026-10-12')
})

test('bilibili: cjk-only videos are dropped, latin-usable ones map by bvid', () => {
  const raw = { data: { result: [
    { bvid: 'BV1xx411c7mD', title: 'Hiring remote <em>developers</em> for our SaaS', description: 'We are hiring remote developers for a growing SaaS platform, EU timezone.', pubdate: 1760000000 },
    { bvid: 'BV1yy411c7mE', title: '纯中文标题没有英文', description: '全部都是中文内容。', pubdate: 1760000000 },
  ] } }
  const items = parseBilibili(raw)
  assert.equal(items.length, 1)
  assert.equal(items[0].url, 'https://www.bilibili.com/video/BV1xx411c7mD')
  assert.equal(items[0].date, '2025-10-09')
})

test('instagram: users with a latin bio become items', () => {
  const raw = { users: [
    { user: { username: 'acmerobotics', full_name: 'Acme Robotics', biography: 'Warehouse robots. Hiring sales engineers in Berlin and remote.' } },
    { user: { username: 'nobio', full_name: 'x', biography: '' } },
  ] }
  const items = parseInstagram(raw)
  assert.equal(items.length, 1)
  assert.equal(items[0].url, 'https://www.instagram.com/acmerobotics/')
})
