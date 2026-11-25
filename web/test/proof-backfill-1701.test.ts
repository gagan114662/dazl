import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { sqliteDb } from '../lib/db/client.ts'
import type { DiscoveredLead } from '../lib/discover/agent.ts'
import { checkLead, isShown } from '../lib/discover/check.ts'
import type { fetchPublicHtml } from '../lib/net/public-fetch.ts'
import { migrateScan } from '../lib/scan/store.ts'

test('a store-opening proof link that now returns 403 cannot qualify from the search title alone', async () => {
  const url = 'https://retail.example/news/new-store'
  const lead: DiscoveredLead = {
    company: 'Example Outfitters', signal: 'opening a new store', evidence_url: url,
    evidence_quote: null, domain: 'retail.example', signal_date: null, person: null, title: null,
    person_source_url: null, linkedin_url: null, email: null, email_source_url: null,
    confidence: 'medium', why: '',
  }
  const checked = await checkLead(lead, [{ url, title: 'Example Outfitters is opening a new store', page_age: null, text: null }],
    async () => new Response(null, { status: 403 }))
  assert.equal(isShown(checked), false)
  assert.equal(checked.proof, 'unseen')
})

test('a tenant backfill holds blocked and unnamed leads, quarantines dead proof, and is idempotent', async () => {
  const { recheckDiscoveryProof } = await import('../lib/proof-backfill.ts')
  const raw = new Database(':memory:')
  try {
    migrateScan(raw)
    migrateConnectors(raw)
    raw.exec(`INSERT INTO scan_jobs (id, user_id, status, business_name, industry, location)
      VALUES ('old-scan', 'workspace', 'running', 'Example', 'Retail', 'US'),
             ('other-scan', 'other-workspace', 'running', 'Other', 'Retail', 'US')`)
    const insert = raw.prepare(`INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, source_kind, confidence)
      VALUES (?, ?, ?, 'Example Outfitters', 'opening a new store', ?, 'discover', 80)`)
    for (const id of ['dead', 'live', 'blocked', 'unnamed', 'throttled', 'enriched', 'soft-dead']) {
      insert.run(id, 'old-scan', ['unnamed', 'enriched'].includes(id) ? '' : 'Avery Lane', `https://retail.example/${id}`)
    }
    insert.run('untouched', 'other-scan', 'Avery Lane', 'https://retail.example/dead')
    raw.exec("UPDATE scan_jobs SET status = 'done'")
    raw.exec(`INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, source_url, source_date, retrieved_at)
      VALUES ('person', 'enriched', 'workspace', 'discover', 'person', 'Avery Lane, Owner', 'https://retail.example/team', '2026-11-23', 1)`)
    const seen: string[] = []
    const readPage: typeof fetchPublicHtml = async url => {
      const id = new URL(url).pathname.slice(1)
      seen.push(id)
      if (id === 'dead') return { error: 'blocked', status: 404 }
      if (id === 'blocked') return { error: 'blocked', status: 403 }
      if (id === 'throttled') return { error: 'blocked', status: 429 }
      return { html: id === 'soft-dead' ? '<h1>Job not found</h1>' : '<p>Example Outfitters is opening a new store.</p>', finalUrl: url, status: 200 }
    }
    const rows = () => raw.prepare('SELECT id, review_reason, quarantine_reason FROM leads ORDER BY id').all()
    const untouched = rows()
    const db = sqliteDb(raw)
    const options = { tenantId: 'workspace', readPage }
    const preview = await recheckDiscoveryProof(db, { ...options, execute: false })
    assert.deepEqual(preview, { checked: 7, quarantined: 2, blocked: 1, unnamed: 1 })
    assert.deepEqual(rows(), untouched)
    const applied = await recheckDiscoveryProof(db, { ...options, execute: true })
    assert.deepEqual(applied, preview)
    const after = rows()
    assert.deepEqual(after, [
      { id: 'blocked', review_reason: 'blocked_by_site', quarantine_reason: null },
      { id: 'dead', review_reason: null, quarantine_reason: 'page_not_found' },
      { id: 'enriched', review_reason: null, quarantine_reason: null },
      { id: 'live', review_reason: null, quarantine_reason: null },
      { id: 'soft-dead', review_reason: null, quarantine_reason: 'page_not_found' },
      { id: 'throttled', review_reason: null, quarantine_reason: null },
      { id: 'unnamed', review_reason: 'no_buyer_named', quarantine_reason: null },
      { id: 'untouched', review_reason: null, quarantine_reason: null },
    ])
    seen.length = 0
    assert.deepEqual(await recheckDiscoveryProof(db, { ...options, execute: true }), { checked: 5, quarantined: 0, blocked: 0, unnamed: 0 })
    assert.equal(seen.includes('dead'), false)
    assert.deepEqual(rows(), after)
  } finally {
    raw.close()
  }
})
