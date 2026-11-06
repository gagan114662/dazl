import test from 'node:test'
import assert from 'node:assert/strict'
import { resetGithubState } from '../lib/sources/github.ts'
import { resetYoutubeState } from '../lib/sources/youtube.ts'
import { resetV2exState } from '../lib/sources/v2ex.ts'
import { resetJinaState } from '../lib/sources/jina.ts'
import { collectEvidenceReport } from '../lib/sources/index.ts'
import type { HttpResult } from '../lib/sources/types.ts'

// #906: the real adapters through the real collectEvidenceReport. A schema failure, an HTML challenge or a wrong collection
// type is never a healthy empty, is never cached as one, and a partially malformed answer keeps its valid rows as 'partial'.
// Only a documented, explicitly empty answer (or valid rows all filtered by policy) reads 'empty'. No network: a local fake http.
type Http = (url: string, opts?: { accept?: string; headers?: Record<string, string> }) => Promise<HttpResult | null>
const Q = 'warehouse robotics startups'
const ok = (body: unknown): HttpResult => ({ status: 200, body: typeof body === 'string' ? body : JSON.stringify(body) })
const HTML = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>'
const reset = () => { resetGithubState(); resetYoutubeState(); resetV2exState(); resetJinaState() }
const run = async (adapter: string, http: Http, extra: { feeds?: string[]; pages?: string[] } = {}) => {
  const r = await collectEvidenceReport({ adapters: [adapter], feeds: extra.feeds ?? [], pages: extra.pages ?? [] }, Q, http)
  return { items: r.items, run: r.runs.find(x => x.collector === `adapter:${adapter}`)! }
}
const REPO = { full_name: 'acme/warehouse-robotics', html_url: 'https://github.com/acme/warehouse-robotics', description: 'Open source warehouse robotics fleet manager for small 3PLs', pushed_at: '2026-10-01T00:00:00Z' }

async function bad(adapter: string, body: string | unknown, code: string, extra?: { feeds?: string[]; pages?: string[] }) {
  reset()
  let calls = 0
  const http = (async () => { calls++; return ok(body) }) as Http
  for (const round of [1, 2]) { // round 2: a repeat read must not replay a cached healthy empty
    const { items, run: r } = await run(adapter, http, extra)
    assert.deepEqual(items, [], `${adapter} ${code} round ${round}`)
    assert.equal(r.status, 'partial', `${adapter} ${JSON.stringify(body).slice(0, 40)} round ${round}: ${JSON.stringify(r)}`)
    assert.ok(r.notes?.[code], `${adapter} expected note ${code}, got ${JSON.stringify(r.notes)}`)
  }
  assert.ok(calls >= 2, `${adapter}: the failure was not served from cache`)
}

test('github: {} / null / items:{} / HTML challenge are malformed or challenge, never a cached empty', async () => {
  for (const b of [{}, null, { items: {} }, { total_count: 0 }]) await bad('github', b, 'malformed')
  await bad('github', HTML, 'challenge')
  reset()
  assert.equal((await run('github', (async () => ({ status: 403, body: '{"message":"API rate limit exceeded"}' })) as Http)).run.notes?.auth_or_blocked, 1)
  reset()
  assert.equal((await run('github', (async () => ({ status: 429, body: '' })) as Http)).run.notes?.throttled, 1)
})

test('github: explicit empty and policy-filtered rows are healthy empty; malformed rows keep the valid ones as partial', async () => {
  reset()
  assert.deepEqual((await run('github', (async () => ok({ total_count: 0, incomplete_results: false, items: [] })) as Http)).run, { collector: 'adapter:github', status: 'empty', evidence: 0 })
  reset() // a valid repository whose description is too short: filtered by policy, not a failure
  assert.equal((await run('github', (async () => ok({ items: [{ ...REPO, description: 'tiny' }] })) as Http)).run.status, 'empty')
  reset()
  let calls = 0
  const mixed = (async () => { calls++; return ok({ items: [REPO, null, 'x', { html_url: 7 }] }) }) as Http
  for (const _ of [1, 2]) {
    const { items, run: r } = await run('github', mixed)
    assert.equal(items.length, 1); assert.equal(r.status, 'partial'); assert.equal(r.notes?.malformed_rows, 1)
  }
  assert.equal(calls, 2, 'a partial answer is not cached as complete')
  reset() // a valid healthy answer is still cached
  calls = 0
  const good = (async () => { calls++; return ok({ items: [REPO] }) }) as Http
  assert.equal((await run('github', good)).run.status, 'ok'); assert.equal((await run('github', good)).run.status, 'ok'); assert.equal(calls, 1)
})

test('youtube (Piped and Data API): wrong envelopes and challenges are noted; malformed rows keep the valid video', async () => {
  const saved = process.env.YOUTUBE_API_KEY
  try {
    delete process.env.YOUTUBE_API_KEY
    for (const b of [{}, null, { items: 'none' }]) await bad('youtube', b, 'malformed')
    await bad('youtube', HTML, 'challenge')
    reset()
    const piped = ok({ items: [{ type: 'stream', url: '/watch?v=AAAAAAAAAAA', title: 'Warehouse robotics hiring trends for operators', uploaded: 1730000000000 }, { url: 5 }] })
    const r = await run('youtube', (async () => piped) as Http)
    assert.equal(r.items.length, 1); assert.equal(r.run.status, 'partial'); assert.equal(r.run.notes?.malformed_rows, 1)
    process.env.YOUTUBE_API_KEY = 'test-key'
    for (const b of [{}, { items: {} }]) await bad('youtube', b, 'malformed')
    reset()
    assert.equal((await run('youtube', (async () => ok({ kind: 'youtube#searchListResponse', items: [] })) as Http)).run.status, 'empty')
  } finally { if (saved === undefined) delete process.env.YOUTUBE_API_KEY; else process.env.YOUTUBE_API_KEY = saved }
})

test('v2ex: malformed search and hot envelopes are noted; the run says when the hot fallback answered', async () => {
  for (const b of [{}, null, { hits: {} }]) {
    reset()
    const http = (async (url: string) => url.includes('sov2ex') ? ok(b) : ok({ not: 'an array' })) as Http
    const { items, run: r } = await run('v2ex', http)
    assert.deepEqual(items, []); assert.equal(r.status, 'partial'); assert.equal(r.notes?.malformed, 2, JSON.stringify(r.notes))
  }
  reset()
  const hot = { id: 9, title: 'Hiring a senior warehouse robotics engineer this quarter', content: 'warehouse robotics', created: 1730000000 }
  const viaHot = await run('v2ex', (async (url: string) => url.includes('sov2ex') ? ok(HTML) : ok([hot, { id: 'x' }])) as Http)
  assert.equal(viaHot.items.length, 1)
  assert.deepEqual(viaHot.run.notes, { challenge: 1, malformed_rows: 1, answered_by_hot_fallback: 1 })
  reset() // genuine empty from both backends stays a healthy empty
  assert.equal((await run('v2ex', (async (url: string) => url.includes('sov2ex') ? ok({ took: 1, total: 0, hits: [] }) : ok([])) as Http)).run.status, 'empty')
})

test('rss: an HTML page or a non-feed body is not an empty feed; a real feed with no matches is', async () => {
  const feeds = ['https://feeds.example/x.xml']
  await bad('rss', HTML, 'challenge', { feeds })
  await bad('rss', '{"items":[]}', 'not_a_feed', { feeds })
  reset()
  assert.equal((await run('rss', (async () => ok('<?xml version="1.0"?><rss version="2.0"><channel><title>x</title></channel></rss>')) as Http, { feeds })).run.status, 'empty')
  reset()
  const feed = '<rss><channel><item><title>Warehouse robotics startup raises a seed round</title><link>https://news.example/a</link></item><item><title>Unrelated gardening tips for the long weekend</title><link>https://news.example/b</link></item></channel></rss>'
  const r = await run('rss', (async () => ok(feed)) as Http, { feeds })
  assert.equal(r.items.length, 1); assert.equal(r.run.status, 'ok')
})

test('jina: a non-reader body or a challenge is noted and not cached; a page with no readable passage is noted', async () => {
  const pages = ['https://acme.example/news']
  await bad('web', HTML, 'challenge', { pages })
  await bad('web', 'just some text', 'malformed', { pages })
  await bad('web', 'Title: Acme\nURL Source: https://acme.example/news\n\nMarkdown Content:\nhi', 'no_readable_text', { pages })
  reset()
  const good = 'Title: Acme news\nURL Source: https://acme.example/news\nPublished Time: 2026-10-01\n\nMarkdown Content:\nAcme is expanding its warehouse robotics team in Toronto with ten new hires this fall.'
  const r = await run('web', (async () => ok(good)) as Http, { pages })
  assert.equal(r.items.length, 1); assert.equal(r.run.status, 'ok')
})
