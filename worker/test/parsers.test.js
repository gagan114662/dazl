import test from 'node:test'
import assert from 'node:assert/strict'
import { parseRedditListing } from '../lib/reddit.js'
import { parseXTweets } from '../lib/x.js'

test('reddit listing parses to worker items matching the app contract', () => {
  const items = parseRedditListing({
    data: { children: [
      { data: { permalink: '/r/startups/comments/abc/we_just_raised/', title: 'We just raised $2M and are hiring', selftext: 'Excited to announce our seed round. We are hiring two founding engineers for our dev tools platform.', created_utc: 1792545600 } },
      { data: { permalink: '/r/x/comments/short/hi/', title: 'hi', selftext: '', created_utc: 1792545600 } }, // too short, dropped
      { data: { permalink: '/r/y/comments/nodate/title_long_enough_to_pass/', title: 'A title that is long enough to be a quote', selftext: '', created_utc: null } },
    ] },
  })
  assert.equal(items.length, 2)
  assert.equal(items[0].url, 'https://www.reddit.com/r/startups/comments/abc/we_just_raised/')
  assert.ok(items[0].quote.length >= 20)
  assert.match(items[0].date, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(items[1].date, null)
  assert.equal(items[1].login_walled, false)
})

test('x search response parses tweets out of the nested GraphQL structure', () => {
  const tweet = (id, text, user) => ({ result: { legacy: { id_str: id, full_text: text, created_at: 'Mon Oct 20 12:00:00 +0000 2026' }, core: { user_results: { result: { core: { screen_name: user } } } } } })
  const items = parseXTweets({ data: { search_by_raw_query: { search_timeline: { timeline: { instructions: [
    { entries: [{ content: { itemContent: { tweet_results: tweet('123', 'we just raised a seed round and are hiring engineers for our dev tools startup', 'acme') } } }] },
    { entries: [{ content: { itemContent: { tweet_results: tweet('123', 'duplicate id, dropped', 'acme') } } }] },
  ] } } } } })
  assert.equal(items.length, 1)
  assert.equal(items[0].url, 'https://x.com/acme/status/123')
  assert.equal(items[0].date, '2026-10-20')
  assert.ok(items[0].quote.length >= 20)
})

test('x parser survives empty and malformed payloads', () => {
  assert.deepEqual(parseXTweets({}), [])
  assert.deepEqual(parseXTweets({ data: { errors: [{ message: 'Rate limit exceeded' }] } }), [])
})
