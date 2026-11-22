import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import Database from 'better-sqlite3'
import { migrateAtsIndex, surtOf, blocksFor, slugsFromCdx, boardSlugOf, addBoards, seedFromPastLeads, idxLinesFor, discoverStep, CDX_PATTERNS } from '../lib/sources/ats-index.ts'

// Real Common Crawl records (CC-MAIN-2026-43, read 2026-11-22 from data.commoncrawl.org): cluster.idx lines around the board hosts,
// and cdx-*.gz block lines (cdx-00037: the end of www.ashbyhq.com, the start of jobs.ashbyhq.com; a job-boards.greenhouse.io sample).
const fx = (f: string) => readFileSync(new URL(`./fixtures/commoncrawl/${f}`, import.meta.url), 'utf8')
const idx = fx('cluster-43.idx').split('\n').filter(Boolean)
const ashby = fx('cdx-00037-ashby.txt'), gh = fx('cdx-greenhouse-job-boards.txt')

test('ATS index: the four board hosts as SURT keys', () => {
  assert.deepEqual(CDX_PATTERNS.map(surtOf), ['com,ashbyhq,jobs)/', 'io,greenhouse,boards)/', 'io,greenhouse,job-boards)/', 'co,lever,jobs)/'])
})
test('ATS index: cluster.idx blocks - the block before the host, then every block starting under it; never another host', () => {
  assert.deepEqual(blocksFor(idx, 'com,ashbyhq,jobs)/'), [{ file: 'cdx-00037.gz', offset: 576196234, length: 327944 }, { file: 'cdx-00037.gz', offset: 576524178, length: 306984 }])
  assert.equal(blocksFor(idx, 'io,greenhouse,job-boards)/').length, 21, 'the block before it, then its 20 blocks')
  assert.ok(blocksFor(idx, 'io,greenhouse,boards)/').length >= 5)
  // no block STARTS with a lever key in this crawl: its captures sit inside the one block before (cdx-00027)
  assert.deepEqual(blocksFor(idx, 'co,lever,jobs)/').map(b => b.file), ['cdx-00027.gz'])
})
test('ATS index: slugs from real block lines - board hosts only, deduped, lowercased; the vendor site is not a board', () => {
  assert.deepEqual(slugsFromCdx(ashby).map(s => `${s.kind}:${s.slug}`).sort(), ['ashby:0g', 'ashby:0x', 'ashby:115ventures', 'ashby:1password', 'ashby:1x'])
  const g = slugsFromCdx(gh)
  assert.ok(g.length >= 25 && g.every(s => s.kind === 'greenhouse'))
  assert.ok(g.some(s => s.slug === 'anthropic') && g.some(s => s.slug === 'apolloio'))
  const lv = slugsFromCdx(fx('cdx-lever.txt'))
  assert.ok(lv.length >= 10 && lv.every(s => s.kind === 'lever'), 'jobs.lever.co boards')
  assert.equal(boardSlugOf('https://boards.greenhouse.io/embed/job_app?for=acme'), null, "the host's own path is not a board")
  assert.deepEqual(boardSlugOf('https://jobs.lever.co/HowGood/a9cf54b8-b57f-4293-ac40-009ebb3aadd9'), { kind: 'lever', slug: 'howgood' })
})
const mem = () => { const db = new Database(':memory:'); migrateAtsIndex(db); return db }
test('ATS index: stored as data with its source; a repeat keeps the first source', () => {
  const db = mem()
  assert.equal(addBoards(db, slugsFromCdx(ashby), 'commoncrawl:CC-MAIN-2026-43', 1), 5)
  assert.equal(addBoards(db, [{ kind: 'ashby', slug: '1password' }], 'past_leads', 2), 0)
  assert.equal((db.prepare("SELECT source FROM ats_boards WHERE slug = '1password'").get() as { source: string }).source, 'commoncrawl:CC-MAIN-2026-43')
})
test('ATS index fallback: past leads seed their boards, labelled past_leads', () => {
  const db = mem()
  db.exec('CREATE TABLE leads (id TEXT, source_url TEXT)')
  for (const u of ['https://job-boards.greenhouse.io/rti/jobs/8371864', 'https://jobs.ashbyhq.com/paddle/c1608b74-e34b-436c-bfe3-539f1ff051e6', 'https://jobs.lever.co/HowGood/a9cf54b8-b57f-4293-ac40-009ebb3aadd9', 'https://example.com/careers'])
    db.prepare('INSERT INTO leads VALUES (?, ?)').run('x', u)
  assert.equal(seedFromPastLeads(db, 3), 3)
  assert.deepEqual((db.prepare('SELECT kind, slug, source FROM ats_boards ORDER BY slug').all() as object[]), [
    { kind: 'lever', slug: 'howgood', source: 'past_leads' }, { kind: 'ashby', slug: 'paddle', source: 'past_leads' }, { kind: 'greenhouse', slug: 'rti', source: 'past_leads' }])
})
// a range-serving stand-in for data.commoncrawl.org: cluster.idx is the real fixture, cdx-00037.gz answers the real ashby block lines
const cc = () => {
  const idxBody = Buffer.from(idx.join('\n') + '\n'), seen: string[] = []
  const f = async (url: string, init?: RequestInit) => {
    seen.push(url)
    if (url.endsWith('/cluster.idx')) {
      if (init?.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-length': String(idxBody.length) } })
      const [a, b] = /bytes=(\d+)-(\d+)/.exec(new Headers(init?.headers).get('range') ?? '')!.slice(1).map(Number)
      return new Response(idxBody.subarray(a, b + 1), { status: 206 })
    }
    if (url.endsWith('/cdx-00037.gz')) return new Response(gzipSync(ashby), { status: 206 })
    return new Response('', { status: 404 })
  }
  return { f, seen }
}
test('ATS index: cluster.idx is read by range and the host lines come back', async () => {
  const { f } = cc()
  const lines = await idxLinesFor(f, 'CC-MAIN-2026-43', 'com,ashbyhq,jobs)/')
  assert.ok(lines.some(l => l.startsWith('com,ashbyhq,jobs)/openai/')))
})
test('ATS index: discovery steps through the blocks, resumable, and stores the slugs', async () => {
  const { f, seen } = cc(), db = mem()
  const s1 = await discoverStep(db, f, 'CC-MAIN-2026-43', 'jobs.ashbyhq.com/*', 10)
  assert.deepEqual(s1, { page: 0, pages: 2, added: 5 })
  assert.ok(seen.every(u => u.startsWith('https://data.commoncrawl.org/cc-index/collections/CC-MAIN-2026-43/indexes/')), 'free open-data files only')
  assert.equal((await discoverStep(db, f, 'CC-MAIN-2026-43', 'jobs.ashbyhq.com/*', 11))?.page, 1)
  assert.equal(await discoverStep(db, f, 'CC-MAIN-2026-43', 'jobs.ashbyhq.com/*', 12), null, 'done')
  assert.equal((db.prepare('SELECT count(*) n FROM ats_boards').get() as { n: number }).n, 5)
})
