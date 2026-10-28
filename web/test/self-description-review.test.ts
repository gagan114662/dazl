// A lead whose only evidence is an owner's description of their own project (a repo description)
// must land in needs-review with reason self_description, never verified, never emailable.
// A non-self-described item in the same run keeps the normal verification path.
import { test } from 'node:test'
import { sqliteDb } from '../lib/db/client.ts'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { migrateScan, createQueryJob, listLeads } from '../lib/scan/store.ts'
import { claimKeyedJob, runJob } from '../lib/scan/runner.ts'
import type { SafeGet } from '../lib/sources/types.ts'
import { confirmLeadReview } from '../lib/scan/review-confirm.ts'
import { createDraft, OutreachError } from '../lib/outreach/service.ts'

const master = randomBytes(32)
const KA = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const DESC = 'Pulseforge builds an AI sales agent for lead discovery and outbound'
const NEWS = 'Northside Builders announced it is hiring three roofing crews for the Toronto market'
const recent = new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10)
const REPO = 'https://github.com/pulseforge/leadgen'
const NEWSURL = 'https://n.example/news/1'
const RSS = `<?xml version="1.0"?><rss><channel><item><title>Northside Builders hiring roofing crews</title><link>${NEWSURL}</link><description>${NEWS}</description><pubDate>${new Date(Date.now() - 20 * 86_400_000).toUTCString()}</pubDate></item></channel></rss>`
const http: SafeGet = async url => {
  if (url.startsWith('https://api.github.com/')) return { status: 200, body: JSON.stringify({ items: [{ full_name: 'pulseforge/leadgen', html_url: REPO, description: DESC, pushed_at: `${recent}T00:00:00Z` }] }) }
  if (url === 'https://n.example/feed') return { status: 200, body: RSS }
  return null
}
const lead = (company: string, url: string, excerpt: string) => ({ name: '', company, contact: null, signal: 'matches', source_url: url, score: 85, excerpt, event_date: recent })
const page = async (url: string) => url === REPO
  ? { text: `${DESC}. Open source.`, title: 'pulseforge/leadgen', retrievedAt: 1_700_000_000 }
  : { text: `News. ${NEWS}. More.`, title: 'Northside Builders news', retrievedAt: 1_700_000_000 }

async function run(urlVariant: (u: string) => string) {
  const db = new Database(':memory:'); migrateScan(db); migrateKeys(db); saveKey(db, 'A', 'anthropic', KA, master)
  const icp = JSON.stringify({ summary: 'x', who: [], industries: [], sizes: [], where: [], signals: [], exclude: [] })
  const id = createQueryJob(db, 'A', { query: 'roofing crews hiring prospecting', icp, sources: JSON.stringify({ adapters: ['github', 'rss'], feeds: ['https://n.example/feed'] }) } as never)
  const out = JSON.stringify([lead('Pulseforge', urlVariant(REPO), DESC), lead('Northside Builders', NEWSURL, NEWS)])
  const prov = { anthropic: { research: async () => ({ text: '[]', citedUrls: [] }), complete: async (_k: string, p: string) => p.startsWith('You check one claim') ? 'supports' : out }, openai: { research: async () => ({ text: '[]', citedUrls: [] }) } }
  const res = await runJob(db, claimKeyedJob(db, id)!, { providers: prov as never, master, fetchPage: page as never, sourceHttp: http, score: false, now: new Date() })
  return { res, db, rows: listLeads(db, 'A', id) as unknown as { company: string; review_reason: string | null; contact: string | null }[] }
}

test('owner self-description lands in review as self_description; the other source verifies normally', async () => {
  const { res, rows } = await run(u => u)
  assert.equal(res, 'done')
  const byCo = Object.fromEntries(rows.map(r => [r.company, r]))
  assert.equal(byCo['Pulseforge'].review_reason, 'self_description')
  assert.equal(byCo['Pulseforge'].contact, null)
  assert.equal(byCo['Northside Builders'].review_reason, null)
})

test('after the user confirms a self_description row, a draft still needs a published email and is refused', async () => {
  const { db, rows } = await run(u => u)
  const lead = (db.prepare("SELECT id FROM leads WHERE company = 'Pulseforge'").get() as { id: string })
  assert.equal(await confirmLeadReview(sqliteDb(db), 'A', lead.id), true)
  assert.throws(() => createDraft(db, 'A', lead.id, 'Test Co'), (e: unknown) => e instanceof OutreachError && e.code === 'no_email_contact')
  assert.ok(rows.length >= 1)
})

test('a trailing slash on the model-returned URL does not bypass the routing', async () => {
  const { rows } = await run(u => u + '/')
  assert.equal(rows.find(r => r.company === 'Pulseforge')!.review_reason, 'self_description')
})

// Frozen real response (api.github.com, captured 2026-10-24) for the query dazl built from
// "B2B companies actively looking for a sales prospecting or lead generation tool". Measures retrieval
// shape only: no model output, no judgment of need. See `note` in the fixture.
import { readFileSync } from 'node:fs'
import { collectEvidence } from '../lib/sources/index.ts'
import { resetGithubState } from '../lib/sources/github.ts'

test('frozen real github corpus: every returned item is tagged owner self-description with no event date', async () => {
  resetGithubState()
  const corpus = JSON.parse(readFileSync(new URL('./fixtures/github-prospecting-query-corpus.json', import.meta.url), 'utf8')) as { items: { full_name: string; html_url: string; description: string | null; pushed_at: string }[] }
  const withDesc = corpus.items.filter(i => (i.description ?? '').replace(/\s+/g, ' ').trim().length >= 20)
  assert.ok(withDesc.length >= 5, 'fixture must hold real items')
  const ev = await collectEvidence({ adapters: ['github'], feeds: [] }, 'B2B companies actively looking for a sales prospecting or lead generation tool', async () => ({ status: 200, body: JSON.stringify(corpus) }), 2000)
  assert.equal(ev.length, withDesc.length)
  for (const e of ev) {
    assert.equal(e.origin, 'owner_self_description', e.url)
    assert.equal(e.date, null, e.url)
    assert.match(e.updated ?? '', /^\d{4}-\d{2}-\d{2}$/, e.url)
  }
})
