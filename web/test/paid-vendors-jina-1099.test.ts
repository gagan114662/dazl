// Refs #1099, Gagan's rule (15 Nov 03:38): no paid third-party API in dazl's default path except Claude. DAZL_PAID_VENDORS empty = off; a control names the vendor.
// Split D of #1273: web pages and funding rounds are read by dazl itself, never through Jina Reader unless named. No network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { jinaAdapter, resetJinaState } from '../lib/sources/jina.ts'
import { fundingRoundFor } from '../lib/signals/funding-round.ts'


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

test('funding round: the article is read by dazl itself, never sent to r.jina.ai, unless Jina is named', async () => {
  const item = { company: 'Kestrel Pay', title: 'Kestrel Pay raises funding', url: 'https://news.example/kestrel-pay-raise', date: '2026-11-04', amount: null, stage: null }
  const realFetch = globalThis.fetch
  const asked: string[] = []
  globalThis.fetch = (async (u: RequestInfo | URL) => { asked.push(String(u)); return new Response('Title: x\n\nMarkdown Content:\nKestrel Pay raised a $5M seed round.', { status: 200 }) }) as typeof fetch
  try {
    await withProcessEnv('', async () => { await fundingRoundFor('Kestrel Pay', [item as never]) })
    assert.ok(!asked.some(u => u.includes('r.jina.ai')), JSON.stringify(asked))
    await withProcessEnv('jina', async () => { await fundingRoundFor('Kestrel Pay', [item as never]) })
    assert.ok(asked.some(u => u.includes('r.jina.ai')), 'control: named, Jina Reader is asked')
  } finally { globalThis.fetch = realFetch }
})
