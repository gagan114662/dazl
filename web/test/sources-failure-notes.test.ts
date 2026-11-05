import test from 'node:test'
import assert from 'node:assert/strict'
import { githubAdapter, resetGithubState } from '../lib/sources/github.ts'
import { youtubeAdapter, resetYoutubeState } from '../lib/sources/youtube.ts'
import { v2exAdapter, resetV2exState } from '../lib/sources/v2ex.ts'
import { rssAdapter } from '../lib/sources/rss.ts'
import { jinaAdapter, resetJinaState } from '../lib/sources/jina.ts'
import { collectEvidenceReport, normalizeSources } from '../lib/sources/index.ts'
import type { HttpResult } from '../lib/sources/types.ts'

// Failure semantics contract (AdapterInput.note): a provider/network/schema failure is a partial result and
// must be noted; only a healthy empty reports nothing. A silent [] on failure shows as 'empty' in the run's
// source rows - a false zero where the truth is "answered but unreadable" or "unreachable".

const rec = () => { const codes: string[] = []; return { codes, note: (c: string) => { codes.push(c) } } }
type Http = (url: string, opts?: { accept?: string; headers?: Record<string, string> }) => Promise<HttpResult | null>
const KW = ['warehouse', 'robotics']

test('github: unreachable, http error, malformed and oversize responses are noted, never a silent empty', async () => {
  resetGithubState()
  let r = rec()
  assert.deepEqual(await githubAdapter.collect({ query: '', keywords: KW, feeds: [], http: (async () => null) as Http, note: r.note }), [])
  assert.deepEqual(r.codes, ['unreachable'])

  resetGithubState()
  r = rec()
  assert.deepEqual(await githubAdapter.collect({ query: '', keywords: KW, feeds: [], http: (async () => ({ status: 500, body: '' })) as Http, note: r.note }), [])
  assert.deepEqual(r.codes, ['http_error'])

  resetGithubState()
  r = rec()
  assert.deepEqual(await githubAdapter.collect({ query: '', keywords: KW, feeds: [], http: (async () => ({ status: 200, body: 'not json' })) as Http, note: r.note }), [])
  assert.deepEqual(r.codes, ['unparseable'])

  resetGithubState()
  r = rec()
  // a cut body must be reported as oversize and never parsed as a prefix
  assert.deepEqual(await githubAdapter.collect({ query: '', keywords: KW, feeds: [], http: (async () => ({ status: 200, body: '{"items":[{"full_name":"acme/robot-sdk"', truncated: true })) as Http, note: r.note }), [])
  assert.deepEqual(r.codes, ['oversize'])
})

test('github: healthy empty stays silent; the hourly budget is noted when it refuses a call', async () => {
  resetGithubState()
  const r = rec()
  const ok = (async () => ({ status: 200, body: '{"items":[]}' })) as Http
  for (let i = 0; i < 30; i++) await githubAdapter.collect({ query: '', keywords: [`kw${i}`, 'robotics'], feeds: [], http: ok, note: r.note })
  assert.deepEqual(r.codes, [])
  await githubAdapter.collect({ query: '', keywords: ['one', 'more'], feeds: [], http: ok, note: r.note })
  assert.deepEqual(r.codes, ['budget'])
})

const PIPED_ITEM = { type: 'stream', url: '/watch?v=AAAAAAAAAAA', title: 'Warehouse robotics hiring trends for operators', uploaded: 1730000000000 }

test('youtube: every failed Piped instance is noted; a later healthy instance still yields evidence', async () => {
  const saved = process.env.YOUTUBE_API_KEY
  delete process.env.YOUTUBE_API_KEY
  try {
    resetYoutubeState()
    let r = rec()
    assert.deepEqual(await youtubeAdapter.collect({ query: '', keywords: KW, feeds: [], http: (async () => null) as Http, note: r.note }), [])
    assert.deepEqual(r.codes, ['unreachable', 'unreachable', 'unreachable'])

    resetYoutubeState()
    r = rec()
    assert.deepEqual(await youtubeAdapter.collect({ query: '', keywords: KW, feeds: [], http: (async () => ({ status: 500, body: '' })) as Http, note: r.note }), [])
    assert.deepEqual(r.codes, ['http_error', 'http_error', 'http_error'])

    resetYoutubeState()
    r = rec()
    let n = 0
    const mixed = (async () => {
      n++
      if (n === 1) return { status: 500, body: '' }
      if (n === 2) return { status: 200, body: 'not json' }
      return { status: 200, body: JSON.stringify({ items: [PIPED_ITEM] }) }
    }) as Http
    const items = await youtubeAdapter.collect({ query: '', keywords: KW, feeds: [], http: mixed, note: r.note })
    assert.equal(items.length, 1)
    assert.deepEqual(r.codes, ['http_error', 'unparseable'])
  } finally {
    if (saved === undefined) delete process.env.YOUTUBE_API_KEY
    else process.env.YOUTUBE_API_KEY = saved
    resetYoutubeState()
  }
})

test('youtube: the Data API path notes failures too', async () => {
  const saved = process.env.YOUTUBE_API_KEY
  process.env.YOUTUBE_API_KEY = 'test-key'
  try {
    resetYoutubeState()
    const r = rec()
    assert.deepEqual(await youtubeAdapter.collect({ query: '', keywords: KW, feeds: [], http: (async () => null) as Http, note: r.note }), [])
    assert.deepEqual(r.codes, ['unreachable'])
  } finally {
    if (saved === undefined) delete process.env.YOUTUBE_API_KEY
    else process.env.YOUTUBE_API_KEY = saved
    resetYoutubeState()
  }
})

test('v2ex: search and fallback failures are noted; fallback evidence still lands with the note', async () => {
  resetV2exState()
  let r = rec()
  assert.deepEqual(await v2exAdapter.collect({ query: '', keywords: KW, feeds: [], http: (async () => null) as Http, note: r.note }), [])
  assert.deepEqual(r.codes, ['unreachable', 'unreachable'])

  resetV2exState()
  r = rec()
  const hotTopic = { id: 123, title: 'Hiring a senior warehouse robotics engineer this quarter', content: 'robotics', created: 1730000000 }
  const dispatch = (async (url: string) => url.includes('sov2ex') ? { status: 500, body: '' } : { status: 200, body: JSON.stringify([hotTopic]) }) as Http
  const items = await v2exAdapter.collect({ query: '', keywords: KW, feeds: [], http: dispatch, note: r.note })
  assert.equal(items.length, 1)
  assert.deepEqual(r.codes, ['http_error'])

  resetV2exState()
  r = rec()
  const malformed = (async (url: string) => url.includes('sov2ex') ? { status: 200, body: 'not json' } : null) as Http
  assert.deepEqual(await v2exAdapter.collect({ query: '', keywords: KW, feeds: [], http: malformed, note: r.note }), [])
  assert.deepEqual(r.codes, ['unparseable', 'unreachable'])
})

test('v2ex: healthy empty stays silent; the hourly budget is noted', async () => {
  resetV2exState()
  const r = rec()
  const ok = (async (url: string) => url.includes('sov2ex') ? { status: 200, body: '{"hits":[]}' } : { status: 200, body: '[]' }) as Http
  for (let i = 0; i < 30; i++) await v2exAdapter.collect({ query: '', keywords: [`kw${i}`, 'robotics'], feeds: [], http: ok, note: r.note })
  assert.deepEqual(r.codes, [])
  await v2exAdapter.collect({ query: '', keywords: ['one', 'more'], feeds: [], http: ok, note: r.note })
  assert.deepEqual(r.codes, ['budget'])
})

test('rss: an unreachable, erroring or oversize feed is noted per feed', async () => {
  let r = rec()
  assert.deepEqual(await rssAdapter.collect({ query: '', keywords: KW, feeds: ['https://a.example/feed'], http: (async () => null) as Http, note: r.note }), [])
  assert.deepEqual(r.codes, ['unreachable'])

  r = rec()
  assert.deepEqual(await rssAdapter.collect({ query: '', keywords: KW, feeds: ['https://a.example/feed'], http: (async () => ({ status: 500, body: '' })) as Http, note: r.note }), [])
  assert.deepEqual(r.codes, ['http_error'])

  r = rec()
  assert.deepEqual(await rssAdapter.collect({ query: '', keywords: KW, feeds: ['https://a.example/feed'], http: (async () => ({ status: 200, body: '<rss><channel><item><title>cut off', truncated: true })) as Http, note: r.note }), [])
  assert.deepEqual(r.codes, ['oversize'])
})

test('jina: an unreachable, erroring or oversize page read is noted', async () => {
  resetJinaState()
  let r = rec()
  assert.deepEqual(await jinaAdapter.collect({ query: '', keywords: KW, feeds: [], pages: ['https://a.example/x'], http: (async () => null) as Http, note: r.note }), [])
  assert.deepEqual(r.codes, ['unreachable'])

  resetJinaState()
  r = rec()
  assert.deepEqual(await jinaAdapter.collect({ query: '', keywords: KW, feeds: [], pages: ['https://a.example/x'], http: (async () => ({ status: 500, body: '' })) as Http, note: r.note }), [])
  assert.deepEqual(r.codes, ['http_error'])

  resetJinaState()
  r = rec()
  assert.deepEqual(await jinaAdapter.collect({ query: '', keywords: KW, feeds: [], pages: ['https://a.example/x'], http: (async () => ({ status: 200, body: '# Title\nsome cut off text', truncated: true })) as Http, note: r.note }), [])
  assert.deepEqual(r.codes, ['oversize'])
})

test('jina: the hourly budget is noted when it stops page reads', async () => {
  resetJinaState()
  const r = rec()
  const err = (async () => ({ status: 500, body: '' })) as Http
  let batch = 0
  while (true) {
    const before = r.codes.length
    await jinaAdapter.collect({ query: '', keywords: KW, feeds: [], pages: [1, 2, 3].map(i => `https://b.example/${batch * 3 + i}`), http: err, note: r.note })
    if (r.codes.slice(before).includes('budget')) break
    batch++
    if (batch > 60) assert.fail('budget never noted')
  }
})

test('run contract: a failing source reports partial, never the false zero of a healthy empty', async () => {
  resetGithubState()
  const sel = normalizeSources({ adapters: ['github'], feeds: [] })!
  const { items, runs } = await collectEvidenceReport(sel, 'warehouse robotics', (async () => ({ status: 503, body: '' })) as Http)
  assert.deepEqual(items, [])
  const run = runs.find(x => x.collector === 'adapter:github')!
  assert.equal(run.status, 'partial')
  assert.deepEqual(run.notes, { http_error: 1 })
})

// Downstream acceptance: the note must travel truthfully through the run rows and the outcome the customer reads,
// including a partial MIXED success - never 'ok' hiding a failure, never 'empty' inventing a zero.

test('run contract: a partial mixed success is partial with its evidence, never ok and never empty', async () => {
  const saved = process.env.YOUTUBE_API_KEY
  delete process.env.YOUTUBE_API_KEY
  try {
    resetYoutubeState()
    const sel = normalizeSources({ adapters: ['youtube'], feeds: [] })!
    let n = 0
    const mixed = (async () => {
      n++
      if (n === 1) return { status: 500, body: '' }
      return { status: 200, body: JSON.stringify({ items: [PIPED_ITEM] }) }
    }) as Http
    const { items, runs } = await collectEvidenceReport(sel, 'warehouse robotics', mixed)
    assert.equal(items.length, 1)
    const run = runs.find(x => x.collector === 'adapter:youtube')!
    assert.equal(run.status, 'partial')
    assert.equal(run.evidence, 1)
    assert.deepEqual(run.notes, { http_error: 1 })
  } finally {
    if (saved === undefined) delete process.env.YOUTUBE_API_KEY
    else process.env.YOUTUBE_API_KEY = saved
    resetYoutubeState()
  }
})

test('run rows to progress: a failing source reads partial with its note; a healthy empty stays a stated zero', async () => {
  resetGithubState()
  const sel = normalizeSources({ adapters: ['github', 'rss'], feeds: ['https://a.example/feed'] })!
  const http = (async (url: string) => url.includes('api.github.com')
    ? { status: 503, body: '' }
    : { status: 200, body: '<?xml version="1.0"?><rss><channel></channel></rss>' }) as Http
  const { runs } = await collectEvidenceReport(sel, 'warehouse robotics', http)
  // exactly what the runner records (runner.ts: one ledger row per adapter run, status verbatim)
  const rows = runs.map(r => ({ collector: r.collector, status: r.status, evidence_count: r.evidence }))
  const { progressOf, sourceFindings } = await import('../lib/scan/progress.ts')
  const prog = progressOf(rows, 'finished')
  const gh = prog.find(p => p.source === 'adapter:github')!
  assert.equal(gh.status, 'partial')
  assert.equal(gh.state, 'done')
  assert.equal(gh.note, 'some of its answer could not be read')
  const rss = prog.find(p => p.source === 'adapter:rss')!
  assert.equal(rss.status, 'empty')
  const findings = sourceFindings(rows, 'finished', false)
  assert.deepEqual(findings.unknown_sources, ['adapter:github'])   // unknown, never a zero
  assert.deepEqual(findings.evidence_sources, [])
  assert.ok(!findings.unknown_sources.includes('adapter:rss'))     // a genuine nothing is stated, not unknown
})

test('outcome: a partial source can never leave an empty result reading as "the sources returned nothing"', async () => {
  const { scanOutcome } = await import('../lib/scan/scan-outcome.ts')
  const base = { id: 'j1', status: 'failed', error: 'no_candidates', candidates: 0, verified: 0, needs_review: 0, dropped: 0, lead_count: 0, search_hits: 0, failed_sources: [] as string[], evidence_sources: [] as { source: string; evidence: number }[], unknown_sources: [] as string[] }
  const withPartial = scanOutcome({ ...base, partial_sources: ['adapter:github (some of its answer could not be read)'] })
  assert.equal(withPartial.kind, 'none_extracted')
  assert.match(withPartial.label, /only in part/)
  assert.match(withPartial.detail ?? '', /does not show that no company matches/)
  assert.notEqual(withPartial.kind, 'zero_match')
  const clean = scanOutcome({ ...base, partial_sources: [] })
  assert.equal(clean.kind, 'zero_match')   // a genuine all-empty scan still says so: no spurious unknown either
})

// Cache failure class (reviewer blocker on e7c2c448): a result during which any failure was noted must never be
// cached - a cache hit replays the items with no note, so a repeat call inside the 15-minute window reads 'empty',
// the same false zero. These tests call twice WITHOUT resetting state.

test('youtube (Piped): a failed fetch is not cached - the repeat call still notes', async () => {
  const saved = process.env.YOUTUBE_API_KEY
  delete process.env.YOUTUBE_API_KEY
  try {
    resetYoutubeState()
    const r = rec()
    const failing = (async () => null) as Http
    await youtubeAdapter.collect({ query: '', keywords: KW, feeds: [], http: failing, note: r.note })
    assert.deepEqual(r.codes, ['unreachable', 'unreachable', 'unreachable'])
    await youtubeAdapter.collect({ query: '', keywords: KW, feeds: [], http: failing, note: r.note })
    assert.deepEqual(r.codes, ['unreachable', 'unreachable', 'unreachable', 'unreachable', 'unreachable', 'unreachable'])
  } finally {
    if (saved === undefined) delete process.env.YOUTUBE_API_KEY
    else process.env.YOUTUBE_API_KEY = saved
    resetYoutubeState()
  }
})

test('youtube (Data API): a failed fetch is not cached - the repeat call still notes', async () => {
  const saved = process.env.YOUTUBE_API_KEY
  process.env.YOUTUBE_API_KEY = 'test-key'
  try {
    resetYoutubeState()
    const r = rec()
    const failing = (async () => ({ status: 500, body: '' })) as Http
    await youtubeAdapter.collect({ query: '', keywords: KW, feeds: [], http: failing, note: r.note })
    await youtubeAdapter.collect({ query: '', keywords: KW, feeds: [], http: failing, note: r.note })
    assert.deepEqual(r.codes, ['http_error', 'http_error'])
  } finally {
    if (saved === undefined) delete process.env.YOUTUBE_API_KEY
    else process.env.YOUTUBE_API_KEY = saved
    resetYoutubeState()
  }
})

test('youtube (Piped) mixed success: evidence with its note, and the repeat call is still partial, never a cached healthy ok', async () => {
  const saved = process.env.YOUTUBE_API_KEY
  delete process.env.YOUTUBE_API_KEY
  try {
    resetYoutubeState()
    const r = rec()
    const mixed = (async (url: string) => url.includes('api.piped.private.coffee')   // the first instance fails every round
      ? { status: 500, body: '' }
      : { status: 200, body: JSON.stringify({ items: [PIPED_ITEM] }) }) as Http
    const first = await youtubeAdapter.collect({ query: '', keywords: KW, feeds: [], http: mixed, note: r.note })
    assert.equal(first.length, 1)
    assert.deepEqual(r.codes, ['http_error'])
    const second = await youtubeAdapter.collect({ query: '', keywords: KW, feeds: [], http: mixed, note: r.note })
    assert.equal(second.length, 1)
    assert.deepEqual(r.codes, ['http_error', 'http_error'])
  } finally {
    if (saved === undefined) delete process.env.YOUTUBE_API_KEY
    else process.env.YOUTUBE_API_KEY = saved
    resetYoutubeState()
  }
})

test('youtube (Piped): a genuine empty stays silent across repeat calls (cached healthy empty is truthful)', async () => {
  const saved = process.env.YOUTUBE_API_KEY
  delete process.env.YOUTUBE_API_KEY
  try {
    resetYoutubeState()
    const r = rec()
    const empty = (async () => ({ status: 200, body: '{"items":[]}' })) as Http
    await youtubeAdapter.collect({ query: '', keywords: KW, feeds: [], http: empty, note: r.note })
    await youtubeAdapter.collect({ query: '', keywords: KW, feeds: [], http: empty, note: r.note })
    assert.deepEqual(r.codes, [])
  } finally {
    if (saved === undefined) delete process.env.YOUTUBE_API_KEY
    else process.env.YOUTUBE_API_KEY = saved
    resetYoutubeState()
  }
})

test('v2ex: a failed fetch is not cached - the repeat call still notes (both search and fallback)', async () => {
  resetV2exState()
  const r = rec()
  const failing = (async () => null) as Http
  await v2exAdapter.collect({ query: '', keywords: KW, feeds: [], http: failing, note: r.note })
  assert.deepEqual(r.codes, ['unreachable', 'unreachable'])
  await v2exAdapter.collect({ query: '', keywords: KW, feeds: [], http: failing, note: r.note })
  assert.deepEqual(r.codes, ['unreachable', 'unreachable', 'unreachable', 'unreachable'])
})

test('v2ex: search fails but the hot fallback answers - evidence with its note, repeat call still notes', async () => {
  resetV2exState()
  const r = rec()
  const hotTopic = { id: 123, title: 'Hiring a senior warehouse robotics engineer this quarter', content: 'robotics', created: 1730000000 }
  const dispatch = (async (url: string) => url.includes('sov2ex') ? { status: 500, body: '' } : { status: 200, body: JSON.stringify([hotTopic]) }) as Http
  const first = await v2exAdapter.collect({ query: '', keywords: KW, feeds: [], http: dispatch, note: r.note })
  assert.equal(first.length, 1)
  assert.deepEqual(r.codes, ['http_error'])
  const second = await v2exAdapter.collect({ query: '', keywords: KW, feeds: [], http: dispatch, note: r.note })
  assert.equal(second.length, 1)
  assert.deepEqual(r.codes, ['http_error', 'http_error'])
})

test('github: a failed fetch is not cached - the repeat call still notes', async () => {
  resetGithubState()
  const r = rec()
  const failing = (async () => ({ status: 503, body: '' })) as Http
  await githubAdapter.collect({ query: '', keywords: KW, feeds: [], http: failing, note: r.note })
  await githubAdapter.collect({ query: '', keywords: KW, feeds: [], http: failing, note: r.note })
  assert.deepEqual(r.codes, ['http_error', 'http_error'])
})

test('jina: a failed page read is not cached - the repeat call still notes', async () => {
  resetJinaState()
  const r = rec()
  const failing = (async () => null) as Http
  await jinaAdapter.collect({ query: '', keywords: KW, feeds: [], pages: ['https://a.example/x'], http: failing, note: r.note })
  await jinaAdapter.collect({ query: '', keywords: KW, feeds: [], pages: ['https://a.example/x'], http: failing, note: r.note })
  assert.deepEqual(r.codes, ['unreachable', 'unreachable'])
})

test('run contract on repeat: a second scan of the same keywords during an outage still reads partial, never a cached false empty', async () => {
  const saved = process.env.YOUTUBE_API_KEY
  delete process.env.YOUTUBE_API_KEY
  try {
    resetYoutubeState()
    const sel = normalizeSources({ adapters: ['youtube'], feeds: [] })!
    const failing = (async () => null) as Http
    for (let i = 0; i < 2; i++) {
      const { runs } = await collectEvidenceReport(sel, 'warehouse robotics', failing)
      const run = runs.find(x => x.collector === 'adapter:youtube')!
      assert.equal(run.status, 'partial')
      assert.deepEqual(run.notes, { unreachable: 3 })
    }
  } finally {
    if (saved === undefined) delete process.env.YOUTUBE_API_KEY
    else process.env.YOUTUBE_API_KEY = saved
    resetYoutubeState()
  }
})
