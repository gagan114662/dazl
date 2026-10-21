import test from 'node:test'
import assert from 'node:assert/strict'
import { fetchLinkedIn, parseLinkedInPosts } from '../lib/linkedin.js'

const SESSION = 'li_at=AQED; JSESSIONID="ajax:123"'
const UPDATE = {
  $type: 'com.linkedin.voyager.feed.render.UpdateV2',
  commentary: { text: { text: 'We just raised our seed round and are hiring two founding engineers for our dev tools platform' } },
  socialDetail: { urn: 'urn:li:activity:7385000000000000001' },
}
const PAYLOAD = { included: [UPDATE, { $type: 'com.linkedin.voyager.identity.profile.Profile', firstName: 'Ada' }] }

test('parseLinkedInPosts walks normalized JSON and emits worker items', () => {
  const items = parseLinkedInPosts(PAYLOAD)
  assert.equal(items.length, 1)
  assert.equal(items[0].url, 'https://www.linkedin.com/feed/update/urn:li:activity:7385000000000000001')
  assert.equal(items[0].login_walled, true)
  assert.ok(items[0].quote.length >= 20)
  assert.equal(items[0].date, null)
})

test('parseLinkedInPosts dedupes, handles ugcPost urns, survives junk', () => {
  const ugc = { commentary: { text: { text: 'Hiring a head of sales for our freshly funded startup, remote friendly' } }, socialDetail: { urn: 'urn:li:ugcPost:7385000000000000002' } }
  const dup = { ...UPDATE }
  const items = parseLinkedInPosts({ included: [ugc, UPDATE, dup] })
  assert.equal(items.length, 2)
  assert.ok(items.some(i => i.url.includes('ugcPost')))
  assert.deepEqual(parseLinkedInPosts({}), [])
  assert.deepEqual(parseLinkedInPosts(null), [])
})

test('parseLinkedInPosts drops short texts and urn-less nodes', () => {
  assert.deepEqual(parseLinkedInPosts({ included: [{ commentary: { text: { text: 'too short' } }, socialDetail: { urn: 'urn:li:activity:1' } }] }), [])
  assert.deepEqual(parseLinkedInPosts({ included: [{ commentary: { text: { text: 'long enough text but no urn anywhere to be found here' } } }] }), [])
})

test('fetchLinkedIn rejects sessions missing li_at/JSESSIONID', async () => {
  await assert.rejects(() => fetchLinkedIn({ query: 'q', session: 'foo=bar' }))
  await assert.rejects(() => fetchLinkedIn({ query: 'q', session: 'li_at=AQED' }))
})

test('fetchLinkedIn parses a 200 and throws on 999/403', async () => {
  const orig = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify(PAYLOAD), { status: 200 })
  try {
    const items = await fetchLinkedIn({ query: 'hiring founding engineer', session: SESSION })
    assert.equal(items.length, 1)
  } finally { globalThis.fetch = orig }
  globalThis.fetch = async () => new Response('nope', { status: 999 })
  try {
    await assert.rejects(() => fetchLinkedIn({ query: 'q', session: SESSION }))
  } finally { globalThis.fetch = orig }
})
