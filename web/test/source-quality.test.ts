import test from 'node:test'
import assert from 'node:assert/strict'
import { classifySource, sourceCap } from '../lib/scan/source-quality.ts'

test('first-party: company name in the hostname keeps full confidence', () => {
  assert.equal(classifySource('https://www.asymptotelabs.ai/blog/seed', 'Asymptote Labs'), 'first_party')
  assert.equal(classifySource('https://infino.ai/blog/seed-round/', 'Infino'), 'first_party')
  assert.equal(sourceCap('https://infino.ai/blog/seed-round/', 'Infino'), 100)
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
