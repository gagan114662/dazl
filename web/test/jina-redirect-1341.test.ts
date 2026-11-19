import { test } from 'node:test'
import assert from 'node:assert/strict'
import { jinaAdapter, resetJinaState } from '../lib/sources/jina.ts'
import type { SafeGet } from '../lib/sources/types.ts'

const original = 'https://publisher.example/article'
const canonical = 'https://canonical.example/story'
const html = '<!doctype html><html><head><title>Funding news</title></head><body><p>Acme Robotics has announced a major seed funding round for its upcoming factory.</p></body></html>'
async function read(locations: string[], httpBody = html) {
  resetJinaState()
  const seen: string[] = [], issues: string[] = []
  const http: SafeGet = async url => {
    seen.push(url)
    const location = locations[seen.length - 1]
    return location === undefined ? { status: 200, body: httpBody } : { status: 301, body: '', location }
  }
  const items = await jinaAdapter.collect({ pages: [original], query: 'seed funding', keywords: ['funding'], feeds: [], http, note: reason => issues.push(reason) })
  return { seen, issues, items }
}

test('direct publisher canonical redirects read guarded relative and absolute hops, keep original citation', async () => {
  const r = await read(['/canonical', canonical])
  assert.deepEqual(r.seen, [original, 'https://publisher.example/canonical', canonical])
  assert.equal(r.items[0]?.url, original)
  assert.match(r.items[0]?.quote ?? '', /Acme Robotics.*seed funding/)
})

test('direct publisher redirects refuse unsafe targets, loops and excessive hops', async () => {
  for (const destination of ['http://publisher.example/plain', 'https://user@publisher.example/path', 'https://publisher.example:444/path', 'http://[', original, 'https://127.0.0.1/a', 'https://169.254.169.254/a', 'https://[::ffff:127.0.0.1]/a']) {
    const r = await read([destination])
    assert.deepEqual(r.seen, [original], destination)
    assert.deepEqual(r.items, [])
    assert.equal(r.issues.length, 1)
  }
  const limit = await read(['/a', '/b', '/c', '/d', '/e', '/f'])
  assert.deepEqual(limit.items, [])
  assert.equal(limit.seen.length, 4)
  assert.equal(limit.issues.length, 1)
})
