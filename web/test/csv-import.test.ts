import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { migrateScan, countActiveJobs, getJob, listLeads } from '../lib/scan/store.ts'
import { migratePlans, scanQuota } from '../lib/plans.ts'
import { setPlan } from './helpers/plan-fixture.ts'
import type { Provider } from '../lib/llm/provider.ts'
import { claimKeyedJob, runJob } from '../lib/scan/runner.ts'
import { batchStatus, createBatch, normalizeDomain, parseDomains, queuePendingRows, MAX_DOMAINS } from '../lib/scan/csv-import.ts'
import { migrateCsv } from '../lib/scan/csv-import.ts'

const master = randomBytes(32)
const KEY = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

function setup() {
  const db = new Database(':memory:')
  migrateScan(db); migrateKeys(db); migratePlans(db); migrateCsv(db)
  saveKey(db, 'A', 'anthropic', KEY, master)
  return db
}

test('normalizeDomain rejects bare public suffixes against the bundled PSL; registrable lookalikes still import', () => {
  // the residual the source-quality review tracked: a suffix import would make every
  // subordinate host first-party for that tenant's evidence caps
  assert.equal('reason' in normalizeDomain('co.uk'), true)
  assert.equal('reason' in normalizeDomain('uk.com'), true)
  assert.equal('reason' in normalizeDomain('com'), true)
  assert.equal('reason' in normalizeDomain('github.io'), true)
  assert.equal('reason' in normalizeDomain('https://co.uk/'), true)
  // genuine registrable domains under those suffixes still import
  assert.deepEqual(normalizeDomain('example.co.uk'), { domain: 'example.co.uk' })
  assert.deepEqual(normalizeDomain('acme.uk.com'), { domain: 'acme.uk.com' })
  assert.deepEqual(normalizeDomain('www.Example.CO.UK'), { domain: 'example.co.uk' })
  assert.deepEqual(normalizeDomain('myteam.github.io'), { domain: 'myteam.github.io' })
})

test('normalizeDomain strips protocol, credentials, port, path and www; rejects IPs and internal hosts', () => {
  assert.deepEqual(normalizeDomain('https://www.Acme.com/pricing?x=1'), { domain: 'acme.com' })
  assert.deepEqual(normalizeDomain('user@host.io:8443/path'), { domain: 'host.io' })
  assert.deepEqual(normalizeDomain('example.com.'), { domain: 'example.com' })
  assert.equal('reason' in normalizeDomain('1.2.3.4'), true)
  assert.equal('reason' in normalizeDomain('::1'), true)
  assert.equal('reason' in normalizeDomain('localhost'), true)
  assert.equal('reason' in normalizeDomain('printer.internal'), true)
  assert.equal('reason' in normalizeDomain('no-tld'), true)
  assert.equal('reason' in normalizeDomain('bad host!.com'), true)
})

test('parseDomains dedupes, skips blanks silently, flags invalid rows, takes the first CSV column, caps at 50', () => {
  const lines = ['domain,notes', 'acme.com,some note', 'https://www.acme.com/', '', '   ', '1.2.3.4', '"quoted.io",x', 'printer.internal']
  const p = parseDomains(lines.join('\n'))
  assert.deepEqual(p.valid, ['domain', 'acme.com', 'quoted.io'].filter(d => d !== 'domain')) // 'domain' header is invalid (no TLD)... 
  assert.equal(p.valid.length, 2)
  assert.deepEqual(p.valid, ['acme.com', 'quoted.io'])
  assert.equal(p.invalid.length, 3) // header, ip, internal
  const many = Array.from({ length: 60 }, (_, i) => `co${i}.com`).join('\n')
  const q = parseDomains(many)
  assert.equal(q.valid.length, MAX_DOMAINS)
  assert.equal(q.overflow, 10)
})

test('queuePendingRows creates one user-funded scan job per domain and batchStatus reports progress', () => {
  const db = setup()
  setPlan(db, 'A', 'pro')
  const b = createBatch(db, 'A', ['acme.com', 'beta.io'])
  const { queued, quotaStop } = queuePendingRows(db, 'A', b)
  assert.equal(queued, 2)
  assert.equal(quotaStop, false)
  const jobs = db.prepare('SELECT csv_domain, batch_id, funded_by, query FROM scan_jobs').all() as { csv_domain: string; batch_id: string; funded_by: string; query: string | null }[]
  assert.equal(jobs.length, 2)
  assert.equal(jobs[0].funded_by, 'user') // never trial
  assert.equal(jobs[0].query, null)
  assert.deepEqual(jobs.map(j => j.csv_domain).sort(), ['acme.com', 'beta.io'])
  assert.ok(jobs.every(j => j.batch_id === b))
  const st = batchStatus(db, 'A', b)!
  assert.equal(st.counts.queued, 2)
  assert.equal(st.rows[0].domain, 'acme.com')
  // tenant isolation
  assert.equal(batchStatus(db, 'B', b), undefined)
  // CSV jobs do not block manual scans
  assert.equal(countActiveJobs(db, 'A'), 0)
})

test('mid-batch quota stop queues what it can and says X of Y ran, quota reached; resume finishes the rest', () => {
  const db = setup()
  // free plan: 50 scans/month. Burn 49.
  const ins = db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES (?, 'A', 'x', '-', '-', 'done')")
  for (let i = 0; i < 49; i++) ins.run(randomBytes(12).toString('hex'))
  const b = createBatch(db, 'A', ['a.com', 'b.com', 'c.com'])
  const r1 = queuePendingRows(db, 'A', b)
  assert.equal(r1.queued, 1)
  assert.equal(r1.quotaStop, true)
  assert.equal(batchStatus(db, 'A', b)!.note, '1 of 3 ran, quota reached')
  assert.equal(scanQuota(db, 'A').allowed, false)
  // upgrade to pro, resume queues the rest
  setPlan(db, 'A', 'pro')
  const r2 = queuePendingRows(db, 'A', b)
  assert.equal(r2.queued, 2)
  assert.equal(r2.quotaStop, false)
  assert.equal(batchStatus(db, 'A', b)!.counts.queued, 3)
})

const QUOTE = 'Acme announced it is hiring three account executives for the Toronto market'
const recent = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)
const lead = { name: 'Pat', company: 'Acme', contact: null, signal: 'Hiring AEs', source_url: 'https://news.com/acme', score: 80, excerpt: QUOTE, event_date: recent }
const page = async () => ({ text: `News ${recent.slice(0, 4)}. ${QUOTE}. More text.`, title: 'Acme news', retrievedAt: 1_700_000_000 })

test('a csv_domain job researches the company and finishes done with the lead written', async () => {
  // Leads through the TinyFish-primary path: the unpriceable web-search research fallback is refused (#379)
  process.env.TINYFISH_API_KEY = 'tf-test'
  try {
  const db = setup()
  const b = createBatch(db, 'A', ['acme.com'])
  queuePendingRows(db, 'A', b)
  const job = claimKeyedJob(db)!
  assert.equal(job.csv_domain, 'acme.com')
  let researchCalls = 0
  const providers: Record<'anthropic' | 'openai', Provider> = {
    anthropic: { research: async () => { researchCalls++; return { text: '', citedUrls: [] } }, complete: async (_k, _p, _f, max) => max === 3000 ? 'Here: ' + JSON.stringify([lead]) : 'supports' },
    openai: { research: async () => ({ text: '', citedUrls: [] }) },
  }
  const fetchImpl = (async (u: string | URL | Request) => {
    const s = String(u)
    if (s.startsWith('https://api.search.tinyfish.ai')) return new Response(JSON.stringify({ results: [{ url: 'https://news.com/acme', title: 'Acme news', snippet: QUOTE, date: recent }] }), { status: 200 })
    if (s.startsWith('https://api.fetch.tinyfish.ai')) return new Response(JSON.stringify({ results: [{ url: 'https://news.com/acme', title: 'Acme news', text: `News ${recent.slice(0, 4)}. ${QUOTE}. More text.` }] }), { status: 200 })
    return new Response('{}', { status: 404 })
  }) as typeof fetch
  assert.equal(await runJob(db, job, { providers, master, fetchPage: page, fetchImpl }), 'done')
  assert.equal(researchCalls, 0, 'the unpriceable fallback was never invoked')
  const st = batchStatus(db, 'A', b)!
  assert.equal(st.counts.done, 1)
  assert.equal(st.rows[0].leads, 1)
  const leads = listLeads(db, 'A', job.id) as { company: string }[]
  assert.equal(leads.length, 1)
  assert.equal(leads[0].company, 'Acme')
  } finally { delete process.env.TINYFISH_API_KEY }
})

test('a csv job whose searches find nothing stops honestly (research refused, #379) and does not burn quota semantics', async () => {
  process.env.TINYFISH_API_KEY = 'tf-test'
  try {
  const db = setup()
  const b = createBatch(db, 'A', ['ghost.example.co'])
  queuePendingRows(db, 'A', b)
  const job = claimKeyedJob(db)!
  // The production wiring: no injected provider, so the run uses the real vendor registry. Any model web-search
  // request would show up in webSearchCalls - the retired method must refuse before any network call (#379).
  let webSearchCalls = 0
  const fetchImpl = (async (u: string | URL | Request, init?: RequestInit) => {
    const s = String(u)
    if ((s.includes('api.anthropic.com') || s.includes('api.openai.com')) && String(init?.body ?? '').includes('web_search')) webSearchCalls++
    if (s.startsWith('https://api.search.tinyfish.ai')) return new Response(JSON.stringify({ results: [] }), { status: 200 })
    if (s.startsWith('https://api.fetch.tinyfish.ai')) return new Response(JSON.stringify({ results: [] }), { status: 200 })
    return new Response('{}', { status: 404 })
  }) as typeof fetch
  assert.equal(await runJob(db, job, { master, fetchPage: page, fetchImpl }), 'failed')
  assert.equal(webSearchCalls, 0, 'the unpriceable fallback was refused before any network call')
  assert.equal(getJob(db, 'A', job.id)?.error, 'budget_stopped', 'an honest stop, not "nothing found" and never an unpriced call')
  assert.equal(batchStatus(db, 'A', b)!.counts.failed, 1)
  } finally { delete process.env.TINYFISH_API_KEY }
})
