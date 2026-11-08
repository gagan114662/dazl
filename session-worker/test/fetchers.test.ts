import test from 'node:test'
import assert from 'node:assert/strict'
import { CAPABILITY, FETCHERS, parseReddit, parseX, parseBilibili, parseInstagram } from '../src/fetchers.ts'

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

test('x: the tweet payload\'s own user object rides as the author - bio verbatim, profile website expanded, company never inferred', () => {
  const tweet = (id: string, text: string, legacy: Record<string, unknown>) => ({
    content: { itemContent: { tweet_results: { result: {
      legacy: { id_str: id, full_text: text, created_at: 'Mon Oct 12 10:00:00 +0000 2026' },
      core: { user_results: { result: { legacy } } },
    } } } },
  })
  const raw = { data: { search_by_raw_query: { search_timeline: { timeline: { instructions: [{ entries: [
    tweet('211', 'Acme doubled our bill overnight, need an alternative this quarter', {
      screen_name: 'kailund', name: 'Kai Lund', description: 'Founder at Tallyline. Building payroll tools for contractors.',
      url: 'https://t.co/abc', entities: { url: { urls: [{ url: 'https://t.co/abc', expanded_url: 'https://tallyline.example/about', display_url: 'tallyline.example/about' }] } },
    }),
    tweet('212', 'Acme support never answers, who else should we switch to?', { screen_name: 'quietuser', name: '', description: '' }),
  ] }] } } } } }
  const items = parseX(raw)
  assert.equal(items.length, 2)
  assert.deepEqual(items[0].author, {
    name: 'Kai Lund',
    headline: 'Founder at Tallyline. Building payroll tools for contractors.',
    company: null, // X carries no structured company field; the bio is never parsed into one
    url: 'https://tallyline.example/about', // the expanded profile website, never the t.co wrapper
  })
  assert.deepEqual(items[1].author, { name: 'quietuser', headline: null, company: null, url: null })
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

test('capability: facebook and xiaohongshu are declared unsupported with reasons; every fetcher platform is covered', () => {
  assert.equal(CAPABILITY.facebook.supported, false)
  assert.match(CAPABILITY.facebook.reason ?? '', /browser worker/)
  assert.equal(CAPABILITY.xiaohongshu.supported, false)
  assert.match(CAPABILITY.xiaohongshu.reason ?? '', /signing is not implemented/)
  for (const p of Object.keys(FETCHERS)) {
    const c = CAPABILITY[p as keyof typeof CAPABILITY]
    assert.ok(c, `CAPABILITY is missing ${p}`)
    if (c.supported) assert.equal(c.reason, null)
    else assert.ok(typeof c.reason === 'string' && c.reason.length > 10, `${p} needs a real reason`)
  }
})

test('unsupported stubs never make a network call and return nothing', async () => {
  await assert.doesNotReject(FETCHERS.facebook('hiring sales', 'session-cookie', {}))
  assert.deepEqual(await FETCHERS.facebook('q', 's', {}), [])
  assert.deepEqual(await FETCHERS.xiaohongshu('q', 's', {}), [])
})

test('parseReddit: the post\'s own username rides as the author; deleted/removed authors and missing fields are omitted', () => {
  const items = parseReddit({ data: { children: [
    { data: { permalink: '/r/saas/1', title: 'Acme is terrible, alternatives?', selftext: 'Acme keeps raising prices and support never answers.', created_utc: 1762000000, author: 'maya-c' } },
    { data: { permalink: '/r/saas/2', title: 'another complaint post here', selftext: 'Acme doubled our bill and we are leaving soon.', created_utc: 1762000000, author: '[deleted]' } },
    { data: { permalink: '/r/saas/3', title: 'third complaint post here', selftext: 'Support has not answered us in three weeks now.', created_utc: 1762000000 } },
  ] } })
  assert.deepEqual(items[0]?.author, { name: 'maya-c', headline: null, company: null, url: null })
  assert.equal(items[1]?.author, undefined)
  assert.equal(items[2]?.author, undefined)
})
