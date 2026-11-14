// Staging demo workspace, 2026-11-13: every search failed with unbounded_fallback_hold, "the free sources could not conclude", while
// TinyFish was configured and healthy. Real rows read through the ops door: tinyfish_usage for the workspace that UTC day = 100 searches
// + 100 fetched URLs = 200 = the per-account daily allowance (TINYFISH_TENANT_DAILY, default 200: search calls + fetched URLs). Every
// later search was refused by that allowance BEFORE any request (scan_source_runs: search:tinyfish skipped_hold, search.attempted 0,
// no tinyfish row in scan_spend_calls), and the stop was labelled a held fallback - a mislabel that read like a broken setting for 6 runs.
// Now the allowance is its own state (skipped_cap) and its own stop (search_allowance_reached), with its own copy.
import test from 'node:test'
import assert from 'node:assert/strict'
import { runFixture, daysAgo, type Fixture } from './helpers/acceptance-harness.ts'
import { fallbackStopCode } from '../lib/scan/runner.ts'
import { SourceRunLedger } from '../lib/scan/source-runs.ts'
import { scanOutcome } from '../lib/scan/scan-outcome.ts'
import { migrateTinyfish } from '../lib/search/tinyfish.ts'

const NEWS = 'https://sifted.example/brightloop-raises-seed'
const QUOTE = 'Brightloop, a London B2B SaaS startup, raised a 3m GBP seed round this month'
const page = { title: 'Brightloop raises seed round', text: `On ${daysAgo(12)}, ${QUOTE}. ${'More about the company and its people. '.repeat(15)}` }
const ICP = { summary: 's', who: ['Founder'], industries: ['SaaS'], sizes: [], where: ['London, UK'], signals: ['announced seed funding'], exclude: [], country: 'GB', language: 'en', window_days: 90 }
const base = (over: Partial<Fixture> = {}): Fixture => ({
  request: 'London B2B SaaS startups that raised seed funding in the last 90 days', modelIcp: ICP, modelQueries: ['London SaaS startup seed round', 'SaaS seed funding London', 'B2B SaaS raised seed'],
  hits: [{ url: NEWS, title: page.title, snippet: QUOTE, date: daysAgo(12) }], tfPages: { [NEWS]: page }, own: { [NEWS]: page },
  extraction: [{ company: 'Brightloop', signal: 'raised a seed round', source_url: NEWS, excerpt: QUOTE, event_date: daysAgo(12) }],
  researchRetired: true,   // the real provider: the paid web-search fallback refuses research_unbounded
  ...over,
} as Fixture)
const today = () => new Date().toISOString().slice(0, 10)
// the workspace's TinyFish units for today, as the staging row read: 100 searches + 100 fetched URLs
const usedUp = (db: import('better-sqlite3').Database) => { migrateTinyfish(db); const ins = db.prepare("INSERT INTO tinyfish_usage (day, tenant_id, kind, n) VALUES (?, 'A', ?, ?)"); ins.run(today(), 'search', 100); ins.run(today(), 'fetch', 100) }
const status = (r: Awaited<ReturnType<typeof runFixture>>, source: string) => (r.db.prepare('SELECT status FROM scan_source_runs WHERE collector = ? ORDER BY attempt DESC LIMIT 1').get(source) as { status: string } | undefined)?.status ?? null

test('staging demo workspace: a daily allowance already used up stops the run as search_allowance_reached, not unbounded_fallback_hold', async () => {
  const saved = { n: process.env.NEWS_SEARCH_ENABLED, t: process.env.TINYFISH_TENANT_DAILY }
  process.env.NEWS_SEARCH_ENABLED = '0'; delete process.env.TINYFISH_TENANT_DAILY   // staging: news off, the default allowance of 200
  try {
    const r = await runFixture(base({ beforeRun: usedUp }))
    assert.equal(r.calls.searches.length, 0, 'nothing was sent to the search API')
    assert.equal(status(r, 'search:tinyfish'), 'skipped_cap')
    assert.equal(r.job.status, 'failed'); assert.equal(r.job.error, 'search_allowance_reached')
    const out = scanOutcome({ status: 'failed', error: 'search_allowance_reached' } as never)
    assert.match(JSON.stringify(out), /allowance for today was used up/)
    assert.doesNotMatch(JSON.stringify(out), /could not conclude|no price bound/)
  } finally { for (const [k, v] of [['NEWS_SEARCH_ENABLED', saved.n], ['TINYFISH_TENANT_DAILY', saved.t]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
})

test('the same run with allowance left searches and finds the lead (the control)', async () => {
  const saved = process.env.NEWS_SEARCH_ENABLED
  process.env.NEWS_SEARCH_ENABLED = '0'
  try {
    const r = await runFixture(base({ beforeRun: db => { migrateTinyfish(db); db.prepare("INSERT INTO tinyfish_usage (day, tenant_id, kind, n) VALUES (?, 'A', 'search', 60)").run(today()) } }))
    assert.ok(r.calls.searches.length >= 1)
    assert.equal(status(r, 'search:tinyfish'), 'ok')
    assert.ok(r.leads.some(l => l.company === 'Brightloop'), JSON.stringify(r.job))
  } finally { if (saved === undefined) delete process.env.NEWS_SEARCH_ENABLED; else process.env.NEWS_SEARCH_ENABLED = saved }
})

test('stop classification: skipped_cap is the allowance; a hold stays a hold; a failed source stays a source error', () => {
  const at = (news: string | null, tf: string | null, first5 = false) => { const l = new SourceRunLedger(); if (news) l.record('search:news', news); if (tf) l.record('search:tinyfish', tf); return fallbackStopCode(l, first5) }
  assert.equal(at('skipped_disabled', 'skipped_cap'), 'search_allowance_reached')
  assert.equal(at('empty', 'skipped_cap'), 'search_allowance_reached')
  assert.equal(at('skipped_disabled', 'skipped_cap', true), 'search_allowance_reached', 'also for a first play')
  assert.equal(at('skipped_disabled', 'skipped_hold'), 'unbounded_fallback_hold')
  assert.equal(at('error:mixed', 'skipped_cap'), 'source_error')
  assert.equal(at('skipped_disabled', null, true), 'no_lead_source')
})
