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
    return location === undefined ? { status: 200, body: httpBody, contentType: 'text/html' } : { status: 301, body: '', location }
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

test('the same publisher page selects a passage for each keyword set', async () => {
  resetJinaState()
  let reads = 0
  const text = '<html><p>The warehouse supplier announced a new package for independent manufacturing companies.</p><p>The accounting practice introduced bookkeeping support for commercial design studios.</p></html>'
  const http: SafeGet = async () => { reads++; return { status: 200, body: text, contentType: 'text/html; charset=utf-8' } }
  const find = (keywords: string[]) => jinaAdapter.collect({ pages: [original], query: keywords.join(' '), keywords, feeds: [], http })
  assert.match((await find(['warehouse']))[0]?.quote ?? '', /warehouse supplier/)
  assert.match((await find(['bookkeeping']))[0]?.quote ?? '', /bookkeeping support/)
  assert.match((await find([' BOOKKEEPING ', 'bookkeeping']))[0]?.quote ?? '', /bookkeeping support/)
  assert.equal(reads, 2, 'repeat normalized keywords reuse their own cached quote')
})

test('direct web evidence needs a confirmed publisher HTML media type and HTML body', async () => {
  for (const [contentType, body] of [
    ['application/json', JSON.stringify({ title: 'Funding news', details: html })],
    ['application/json', html],
    [undefined, html],
  ] as const) {
    resetJinaState()
    const notes: string[] = []
    const items = await jinaAdapter.collect({ pages: [original], query: 'funding', keywords: ['funding'], feeds: [],
      http: async () => ({ status: 200, contentType, body }), note: note => notes.push(note) })
    assert.deepEqual(items, [])
    assert.deepEqual(notes, ['malformed'])
  }
})
