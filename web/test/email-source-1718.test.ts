import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { saveKey } from '../lib/llm/key-store.ts'
import { claimKeyedJob, runJob } from '../lib/scan/runner.ts'
import { createQueryJob } from '../lib/scan/store.ts'
import { checkEmailSource } from '../lib/discover/check.ts'
import { runDiscovery } from '../lib/discover/run.ts'
import type { DiscoverResult } from '../lib/discover/agent.ts'
import { discoverContact, discoverGuessedEmail, discoverSources, PAGE_PROVEN_EMAIL_LABEL } from '../lib/discover/card.ts'

import { displayedEmailSource } from '../lib/outreach/published-email.ts'

const url = 'https://example.com/about'
const email = 'buyer@example.com'
const quote = 'Example is opening a new site'

function discoveryResult(page: string): DiscoverResult {
  return {
    leads: [{ company: 'Example', domain: 'example.com', signal: 'opening a new site',
      signal_date: '2026-11-24', evidence_url: url, evidence_quote: quote,
      person: 'Dana Buyer', title: 'Owner', person_source_url: url, linkedin_url: null,
      email, email_source_url: url, confidence: 'medium', why: '' }],
    seen: [{ url, title: 'Example', page_age: null, text: quote + '. ' + page }],
    usage: { usd: 0.3, requests: 1, searches: 1, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
    stop: 'end_turn', model: 'test', note: null,
  }
}

function run(page: string) {
  return runDiscovery({ query: 'opening a new site' }, { maxUsd: 0.3 }, {
    apiKey: 'test', judge: null, enrich: null, discover: async () => discoveryResult(page),
    fetch: async () => { throw new Error('fixture uses only the page already read') },
  })
}

test('a cited page listing only its press inbox does not prove a buyer email', async () => {
  const { leads: [lead] } = await run('Media contact: press@example.com.')
  assert.deepEqual([lead.email, lead.email_source_url], [null, null])
})

test('the exact email on the cited page survives bracket and entity decoding', async () => {
  for (const page of ['Dana Buyer (BUYER [at] Example.com).', 'Dana Buyer (buyer&#64;example&period;com).']) {
    const { leads: [lead] } = await run(page)
    assert.deepEqual([lead.email, lead.email_source_url], [email, url])
  }
})

test('a longer mailbox or hostname does not prove a substring', async () => {
  const { leads: [lead] } = await run('another-buyer@example.com and buyer@example.com.other')
  assert.equal(lead.email, null)
})

test('a legacy discovery citation does not prove the address was read', () => {
  const lead = { source_kind: 'discover', name: 'Dana Buyer', source_url: url,
    enrichments: [{ connector: 'discover', kind: 'email', value: email, source_url: url, label: 'published on a public page' }] }
  assert.equal(discoverContact(lead)?.email, null)
  assert.equal(discoverSources(lead).some(source => source.field === 'email'), false)
})

test('a proof-marked email supplies its own source; guessing never supplies a published contact', () => {
  const row = { connector: 'discover', kind: 'email', value: email, source_url: url, label: PAGE_PROVEN_EMAIL_LABEL }
  const proven = { source_kind: 'discover', name: 'Dana Buyer', enrichments: [row] }
  assert.deepEqual(discoverContact(proven)?.email, { address: email, source: url })
  assert.deepEqual(discoverSources(proven), [{ field: 'email', label: 'Email', url }])

  const guessed = { ...proven, enrichments: [{ ...row, label: 'guessed', source_url: null }] }
  assert.equal(discoverGuessedEmail(guessed, false), null)
  assert.equal(discoverGuessedEmail(guessed, true), email)
  assert.equal(discoverContact(guessed)?.email, null)
  assert.deepEqual(discoverSources(guessed), [])
})

test('legacy contact citations use the crawl page or the evidence that contains the address', () => {
  const lead = { contact: email, source_url: url, evidence_excerpt: 'Media contact: press@example.com.' }
  assert.equal(displayedEmailSource(lead, email), null)
  assert.equal(displayedEmailSource({ ...lead, evidence_excerpt: 'Contact: Buyer@example.com.' }, email), url)
  const crawl = { connector: 'sitecrawl', kind: 'email', value: email, source_url: 'https://example.com/team' }
  assert.equal(displayedEmailSource({ ...lead, enrichments: [crawl] }, email), crawl.source_url)
  assert.equal(displayedEmailSource({ ...lead, enrichments: [{ ...crawl, source_url: 'javascript:alert(1)' }] }, email), null)
})

test('search results and other pages do not prove the email; a read of the exact URL can', async () => {
  const lead = { email, email_source_url: url }
  const seen = [
    { url, title: email, page_age: null, text: null },
    { url: 'https://example.com/other', title: null, page_age: null, text: email },
  ]
  assert.deepEqual(await checkEmailSource(lead, seen, async () => null), { email: null, email_source_url: null })
  assert.deepEqual(await checkEmailSource(lead, seen, async source => {
    assert.equal(source, url)
    return { text: email }
  }), lead)
})

test('the scan writes no published enrichment for a missing address with guessing off', async () => {
  const db = new Database(':memory:')
  try {
    migrateAllSqlite(db)
    const key = randomBytes(32)
    saveKey(db, 'T', 'anthropic', 'sk-ant-test', key)
    const id = createQueryJob(db, 'T', { query: 'Find companies opening a new site', seller: 'Business equipment' })
    const job = claimKeyedJob(db, id)
    assert.ok(job)
    const result = discoveryResult('Media contact: press@example.com.')
    assert.equal(await runJob(db, job, { master: key, discover: true, enrichImpl: null,
      discoverImpl: async () => result, fetchImpl: async () => new Response(null, { status: 404 }) }), 'done')
    const row = db.prepare('SELECT id, contact FROM leads WHERE scan_job_id = ?').get(id) as { id: string; contact: string | null }
    assert.equal(row.contact, null)
    assert.deepEqual(db.prepare("SELECT value FROM lead_enrichments WHERE lead_id = ? AND kind = 'email'").all(row.id), [])
  } finally {
    db.close()
  }
})
