// Refs #1099, Gagan's rule (15 Nov 03:38): dazl calls no paid third-party API in its default path except Claude. Every gate below runs with
// DAZL_PAID_VENDORS empty (the default an operator gets) and proves NO request reaches the vendor; a control names the vendor and proves
// the same code still runs when an operator opts in. Tests of the vendor code paths opt in (test/paid-vendors-on.ts),
// so each test here sets the variable itself. Invented companies and keys; fake fetch; no network.
// Part of the #1273 split: page reading (web pages source, funding round) without Jina Reader.
import test from 'node:test'
import assert from 'node:assert/strict'
import { jinaAdapter, resetJinaState } from '../lib/sources/jina.ts'

async function withProcessEnv<T>(v: string | undefined, fn: () => Promise<T> | T): Promise<T> {
  const had = process.env.DAZL_PAID_VENDORS
  if (v === undefined) delete process.env.DAZL_PAID_VENDORS; else process.env.DAZL_PAID_VENDORS = v
  try { return await fn() } finally { if (had === undefined) delete process.env.DAZL_PAID_VENDORS; else process.env.DAZL_PAID_VENDORS = had }
}

test('web pages source: read directly by dazl, never through r.jina.ai, unless Jina is named', async () => {
  const PAGE = 'https://kestreldental.example/news/second-office'
  const html = '<html><head><title>Kestrel Dental opens a second office</title></head><body><p>Kestrel Dental opened its second dental office in Brooklyn this month, with six new chairs.</p></body></html>'
  const asked: string[] = []
  const http = async (url: string) => { asked.push(url); return url === PAGE ? { status: 200, body: html } : null }
  await withProcessEnv('', async () => {
    resetJinaState()
    assert.match(jinaAdapter.label, /read directly by dazl/)
    const out = await jinaAdapter.collect({ query: 'q', keywords: ['dental'], feeds: [], pages: [PAGE], http })
    assert.deepEqual(asked, [PAGE], 'the page itself, not r.jina.ai')
    assert.equal(out.length, 1); assert.equal(out[0].url, PAGE); assert.match(out[0].quote, /second dental office in Brooklyn/)
    // a bot wall is noted, never a quote (council review)
    resetJinaState(); const notes: string[] = []
    const wall = '<html><head><title>Just a moment...</title></head><body>Checking your browser before accessing kestreldental.example. This process is automatic. Please enable JavaScript and cookies to continue.</body></html>'
    const walled = await jinaAdapter.collect({ query: 'q', keywords: ['dental'], feeds: [], pages: [PAGE], http: async () => ({ status: 200, body: wall }), note: c => notes.push(c) })
    assert.deepEqual(walled, []); assert.ok(notes.length === 1 && ['challenge', 'js_required'].includes(notes[0]), JSON.stringify(notes))
  })
  await withProcessEnv('jina', async () => {
    resetJinaState(); asked.length = 0
    await jinaAdapter.collect({ query: 'q', keywords: ['dental'], feeds: [], pages: [PAGE], http })
    assert.deepEqual(asked, [`https://r.jina.ai/${PAGE}`])
  })
})

test('an opted-in reader cache cannot supply article evidence to the default path', async () => {
  const PAGE = 'https://kestreldental.example/cached-article'
  const asked: string[] = []
  const markdown = 'Title: Cached page\n\nMarkdown Content:\nKestrel Dental opened its second dental office in Brooklyn this month, with six new chairs.'
  const http = async (url: string) => {
    asked.push(url)
    return url.startsWith('https://r.jina.ai/') ? { status: 200, body: markdown } : { status: 403, body: '' }
  }
  const input = { query: 'q', keywords: ['dental'], feeds: [], pages: [PAGE], http }
  resetJinaState()
  await withProcessEnv('jina', async () => {
    assert.equal((await jinaAdapter.collect(input)).length, 1)
    assert.equal((await jinaAdapter.collect(input)).length, 1, 'opted-in cache stays useful')
  })
  await withProcessEnv(undefined, async () => assert.deepEqual(await jinaAdapter.collect(input), []))
  assert.deepEqual(asked, ['https://r.jina.ai/' + PAGE, PAGE])
})
