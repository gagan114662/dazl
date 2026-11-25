import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { sqliteDb } from '../lib/db/client.ts'
import type { DiscoveredLead } from '../lib/discover/agent.ts'
import { discoverState } from '../lib/discover/card.ts'
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
  const dir = mkdtempSync(join(tmpdir(), 'proof-backfill-'))
  const path = join(dir, 'store.sqlite')
  const raw = new Database(path)
  try {
    migrateScan(raw)
    migrateConnectors(raw)
    raw.exec(`INSERT INTO scan_jobs (id, user_id, status, business_name, industry, location)
      VALUES ('old-scan', 'workspace', 'running', 'Example', 'Retail', 'US'),
             ('other-scan', 'other-workspace', 'running', 'Other', 'Retail', 'US')`)
    const insert = raw.prepare(`INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, source_kind, confidence)
      VALUES (?, ?, ?, 'Example Outfitters', 'opening a new store', ?, 'discover', 80)`)
    for (const id of ['dead', 'live', 'blocked', 'unnamed', 'throttled', 'enriched', 'soft-dead', 'blocked-unnamed']) {
      insert.run(id, 'old-scan', ['unnamed', 'enriched', 'blocked-unnamed'].includes(id) ? '' : 'Avery Lane', `https://retail.example/${id}`)
    }
    insert.run('untouched', 'other-scan', 'Avery Lane', 'https://retail.example/dead')
    raw.exec("UPDATE scan_jobs SET status = 'done'")
    raw.exec("UPDATE leads SET human_confirmed_at = 10 WHERE id = 'dead'")
    raw.exec(`INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, source_url, source_date, retrieved_at)
      VALUES ('person', 'enriched', 'workspace', 'discover', 'person', 'Avery Lane, Owner', 'https://retail.example/team', '2026-11-23', 1)`)
    const seen: string[] = []
    const readPage: typeof fetchPublicHtml = async url => {
      const id = new URL(url).pathname.slice(1)
      seen.push(id)
      if (id === 'dead') return { error: 'blocked', status: 404 }
      if (id === 'blocked' || id === 'blocked-unnamed') return { error: 'blocked', status: 403 }
      if (id === 'throttled') return { error: 'blocked', status: 429 }
      return { html: id === 'soft-dead' ? '<h1>Job not found</h1>' : '<p>Example Outfitters is opening a new store.</p>', finalUrl: url, status: 200 }
    }
    const rows = () => raw.prepare('SELECT id, review_reason, quarantine_reason FROM leads ORDER BY id').all()
    const untouched = rows()
    const db = sqliteDb(raw)
    const options = { tenantId: 'workspace', readPage }
    const readonly = sqliteDb(new Database(path, { readonly: true, fileMustExist: true }))
    let preview
    try {
      preview = await recheckDiscoveryProof(readonly, { ...options, execute: false })
    } finally {
      await readonly.close()
    }
    assert.deepEqual(preview, { checked: 8, quarantined: 2, blocked: 1, unnamed: 2 })
    assert.deepEqual(rows(), untouched)
    const applied = await recheckDiscoveryProof(db, { ...options, execute: true })
    assert.deepEqual(applied, preview)
    const after = rows()
    assert.deepEqual(after, [
      { id: 'blocked', review_reason: 'blocked_by_site', quarantine_reason: null },
      { id: 'blocked-unnamed', review_reason: 'no_buyer_named', quarantine_reason: null },
      { id: 'dead', review_reason: null, quarantine_reason: 'page_not_found' },
      { id: 'enriched', review_reason: null, quarantine_reason: null },
      { id: 'live', review_reason: null, quarantine_reason: null },
      { id: 'soft-dead', review_reason: null, quarantine_reason: 'page_not_found' },
      { id: 'throttled', review_reason: null, quarantine_reason: null },
      { id: 'unnamed', review_reason: 'no_buyer_named', quarantine_reason: null },
      { id: 'untouched', review_reason: null, quarantine_reason: null },
    ])
    seen.length = 0
    assert.deepEqual(await recheckDiscoveryProof(db, { ...options, execute: true }), { checked: 6, quarantined: 0, blocked: 0, unnamed: 0 })
    assert.equal(seen.includes('dead'), false)
    assert.deepEqual(rows(), after)
    // A later human confirmation clears its proof hold even if the site still blocks an automated check.
    raw.exec("UPDATE leads SET human_confirmed_at = 20, review_reason = NULL WHERE id = 'blocked'")
    const confirmed = rows()
    assert.deepEqual(await recheckDiscoveryProof(db, { ...options, execute: true }), { checked: 6, quarantined: 0, blocked: 0, unnamed: 0 })
    assert.deepEqual(rows(), confirmed)
    assert.equal(raw.prepare("SELECT human_confirmed_at FROM leads WHERE id = 'blocked'").pluck().get(), 20)
    raw.exec("UPDATE leads SET human_confirmed_at = 30, review_reason = NULL WHERE id = 'unnamed'")
    assert.deepEqual(await recheckDiscoveryProof(db, { ...options, execute: true }), { checked: 6, quarantined: 0, blocked: 0, unnamed: 1 })
    assert.deepEqual(raw.prepare("SELECT human_confirmed_at, review_reason FROM leads WHERE id = 'unnamed'").get(),
      { human_confirmed_at: 30, review_reason: 'no_buyer_named' })
  } finally {
    raw.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an unnamed buyer does not override an undated or gated discovery lead', () => {
  const lead = { source_kind: 'discover', review_reason: 'no_buyer_named' }
  assert.equal(discoverState({ ...lead, event_date: null }), 'research')
  const now = new Date().toISOString().slice(0, 10)
  assert.equal(discoverState({ ...lead, event_date: now, gate_held: true }), 'research')
  assert.equal(discoverState({ ...lead, event_date: now }), 'no_contact')
})
