// #1157: the free news search (GDELT) answered 429 or not at all on prod (3 of 3 requests failed). A throttled or unanswered
// request is retried ONCE after a backoff; if the retry fails too the remaining queries are not sent and the stage ends with what
// it has (the run then goes on with its other sources: lib/scan/runner.ts fallbackStopCode). Stand-in http, no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { newsSearch, resetNewsQueue } from '../lib/search/news.ts'

let n = 0
const OK = (_url: string) => JSON.stringify({ articles: [{ url: `https://news.example/story-${++n}`, title: 'Acme opens office', seendate: '20261110T000000Z' }] })   // a different story per answer
const script = (answers: ({ status: number; body: string } | null)[]) => {
  const calls: string[] = []
  const http = async (url: string) => { calls.push(url); const a = answers.shift(); return a === undefined ? { status: 200, body: OK(url) } : a }
  return { http, calls }
}
const run = async (answers: ({ status: number; body: string } | null)[], queries = ['a', 'b', 'c']) => {
  resetNewsQueue()
  const { http, calls } = script(answers), waits: number[] = []
  const r = await newsSearch(http as never, queries, 'en', { gapMs: 0, sleep: async ms => { waits.push(ms) }, retryBackoffMs: 8000 })
  return { r, calls, waits }
}

test('a 429 on the first query is retried once after the backoff; the retry answering makes the query ok and the others run', async () => {
  const { r, calls, waits } = await run([{ status: 429, body: '' }])
  assert.equal(calls.length, 4, 'a, a again, b, c'); assert.ok(waits.includes(8000), 'the backoff was waited')
  assert.deepEqual([r.attempted, r.failed, r.query_classes.ok, r.retried, r.gave_up], [3, 0, 3, 1, false])
  assert.equal(r.hits.length, 3)
})

test('no answer (timeout / reset) is retried the same way', async () => {
  const { r, calls } = await run([null])
  assert.equal(calls.length, 4); assert.deepEqual([r.failed, r.retried, r.gave_up, r.query_classes.ok], [0, 1, false, 3])
})

test('the retry fails too: the remaining queries are not sent, the failure is counted with its class, and the stage gives up', async () => {
  const { r, calls } = await run([{ status: 429, body: '' }, { status: 429, body: '' }])
  assert.equal(calls.length, 2, 'only the first query and its one retry')
  assert.deepEqual([r.attempted, r.failed, r.failure_classes.http, r.http_statuses['429'], r.retried, r.gave_up, r.hits.length], [1, 1, 1, 1, 1, true, 0])
  const n = await run([null, null]); assert.equal(n.calls.length, 2); assert.deepEqual([n.r.failure_classes.network, n.r.gave_up], [1, true])
})

test('only one retry per scan: a second outage later ends the stage at once, keeping the hits already found', async () => {
  // a: ok; b: 429 -> its retry ok; c: no answer -> the retry is spent -> the stage gives up
  const { r, calls } = await run([{ status: 200, body: OK('a') }, { status: 429, body: '' }, { status: 200, body: OK('b') }, null])
  assert.equal(calls.length, 4)
  assert.deepEqual([r.query_classes.ok, r.failed, r.failure_classes.network, r.retried, r.gave_up, r.hits.length], [2, 1, 1, 1, true, 2])
})

test('not retried: a clean answer, an empty answer, a parse failure, a 4xx that is not 429, and the provider\'s own "Please limit requests" body', async () => {
  for (const a of [{ status: 200, body: JSON.stringify({ articles: [] }) }, { status: 200, body: 'not json' }, { status: 404, body: '' }, { status: 200, body: 'Please limit requests to one every 5 seconds' }]) {
    const { r } = await run([a, { status: 200, body: JSON.stringify({ articles: [] }) }, { status: 200, body: JSON.stringify({ articles: [] }) }])
    assert.equal(r.retried, 0, a.body.slice(0, 20) + a.status)
  }
})
