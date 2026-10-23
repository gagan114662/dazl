import test from 'node:test'
import assert from 'node:assert/strict'
import { classifySource, sourceCap } from '../lib/scan/source-quality.ts'

test('first-party: only a source-of-truth company domain (exact or subdomain) keeps full confidence', () => {
  assert.equal(classifySource('https://www.asymptotelabs.ai/blog/seed', 'Asymptote Labs', 'asymptotelabs.ai'), 'first_party')
  assert.equal(classifySource('https://infino.ai/blog/seed-round/', 'Infino', 'infino.ai'), 'first_party')
  assert.equal(sourceCap('https://infino.ai/blog/seed-round/', 'Infino', 'infino.ai'), 100)
})

test('editorial: trade press and company-authored releases cap at 90', () => {
  assert.equal(classifySource('https://techcrunch.com/2026/02/17/ai-companies', 'Inferact'), 'editorial')
  assert.equal(classifySource('https://techcabal.com/2026/10/09/vatar-raises/', 'Vatar Inc'), 'editorial')
  assert.equal(classifySource('https://news.ycombinator.com/item?id=123', 'Acme'), 'editorial')
  assert.equal(sourceCap('https://www.siliconangle.com/2026/10/01/satlyt/', 'Satlyt'), 90)
})

test('aggregator: directories, jobs boards and content farms cap at 60', () => {
  assert.equal(classifySource('https://newmarketpitch.com/blogs/news/generative-ai-funding-news', 'Photon'), 'aggregator')
  assert.equal(classifySource('https://www.vcbacked.co/directory/industries/ai-infrastructure', 'Herdr'), 'aggregator')
  assert.equal(classifySource('https://purpose.jobs/blog/top-remote-startups', 'Deel'), 'aggregator')
  assert.equal(classifySource('https://www.dxbstart.com/dubai-proptech-startups-2026', 'Rentify'), 'aggregator')
  assert.equal(classifySource('https://www.ycombinator.com/jobs/role/all/remote', 'Great Question'), 'aggregator')
  assert.equal(sourceCap('https://af.net/realtime/us-ai-startups', 'Preference Model'), 60)
})

test('unknown third party caps at 75; bad urls are unknown', () => {
  assert.equal(sourceCap('https://some-random-blog.example/post', 'Acme'), 75)
  assert.equal(sourceCap('not a url', 'Acme'), 75)
})

import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { migrateScan, createQueryJob } from '../lib/scan/store.ts'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { claimKeyedJob, runJob } from '../lib/scan/runner.ts'
import { scansThisMonth } from '../lib/plans.ts'

test('zero candidates: scan fails with no_candidates and does not burn monthly quota', async () => {
  const db = new Database(':memory:')
  migrateScan(db); migrateKeys(db)
  const master = randomBytes(32)
  saveKey(db, 'u1', 'anthropic', 'sk-ant-' + 'a'.repeat(40), master)
  const id = createQueryJob(db, 'u1', { query: 'nothing will match this' })
  const prov = { research: async () => ({ text: '[]', citedUrls: [] }) }
  const out = await runJob(db, claimKeyedJob(db)!, { providers: { anthropic: prov, openai: prov } as never, master, fetchPage: async () => null, judge: null })
  assert.equal(out, 'failed')
  assert.equal((db.prepare('SELECT error FROM scan_jobs WHERE id = ?').get(id) as { error: string }).error, 'no_candidates')
  assert.equal(scansThisMonth(db, 'u1'), 0)
})

test('lookalike hosts are not first-party: name resemblance never qualifies', async () => {
  const { classifySource, sourceCap } = await import('../lib/scan/source-quality.ts')
  // Without a known company domain, even the genuine-looking host is not first-party;
  // the company's own pages classify like any third party until a domain is known.
  assert.equal(classifySource('https://acme.com/about', 'Acme'), 'unknown')
  assert.equal(classifySource('https://careers.acme.com/jobs/123', 'Acme'), 'aggregator') // jobs path rule
  // Spoof shapes never qualify, with or without a known domain
  assert.equal(classifySource('https://notacme.com/about', 'Acme'), 'unknown')
  assert.equal(classifySource('https://notacme.com/about', 'Acme', 'acme.com'), 'unknown')
  assert.equal(classifySource('https://acme.com.evil-example.com/', 'Acme', 'acme.com'), 'unknown')
  assert.equal(classifySource('https://acmefraud.com/', 'Acme', 'acme.com'), 'unknown')
  assert.equal(classifySource('https://acme-sucks.com/', 'Acme', 'acme.com'), 'unknown')
  // Spoofs no longer earn the first-party cap
  assert.equal(sourceCap('https://acme.com.evil-example.com/', 'Acme', 'acme.com'), 75)
  assert.equal(sourceCap('https://notacme.com/', 'Acme', 'acme.com'), 75)
  // With a source-of-truth domain (the CSV-import job's domain), exact and subdomain qualify
  assert.equal(classifySource('https://acme.com/about', 'Acme', 'acme.com'), 'first_party')
  assert.equal(classifySource('https://careers.acme.com/jobs/123', 'Acme', 'acme.com'), 'first_party')
  assert.equal(classifySource('https://blog.acme.co.uk/post', 'Acme', 'acme.co.uk'), 'first_party')
  assert.equal(sourceCap('https://acme.com/about', 'Acme', 'acme.com'), 100)
  // www prefix on either side still matches the same registrable host
  assert.equal(classifySource('https://www.acme.com/', 'Acme', 'www.acme.com'), 'first_party')
})
