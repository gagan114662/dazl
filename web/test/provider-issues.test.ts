import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateConnectors, audit } from '../lib/connectors/store.ts'
import { setDb, asDb } from '../lib/db/client.ts'
import { providerIssues, providerIssueText } from '../lib/scan/provider-issues.ts'

async function setup() {
  const d = new Database(':memory:')
  migrateConnectors(d)
  setDb(asDb(d))
  return d
}

test('provider failures for THIS scan are surfaced, grouped, with counts', async () => {
  const d = await setup()
  audit(d, { tenantId: 't1', connector: 'enrich:apollo', jobId: 'j1', lookup: 'org Acme', status: 'rate_limited', results: 0 })
  audit(d, { tenantId: 't1', connector: 'enrich:apollo', jobId: 'j1', lookup: 'org Beta', status: 'rate_limited', results: 0 })
  audit(d, { tenantId: 't1', connector: 'enrich:pdl', jobId: 'j1', lookup: 'people Acme', status: 'auth', results: 0 })
  const issues = await providerIssues('t1', 'j1')
  assert.ok(issues)
  assert.equal(issues.length, 2)
  const apollo = issues.find(i => i.connector === 'enrich:apollo')!
  assert.equal(apollo.status, 'rate_limited')
  assert.equal(apollo.lookups_affected, 2)
  const pdl = issues.find(i => i.connector === 'enrich:pdl')!
  assert.equal(pdl.status, 'auth')
  assert.equal(pdl.lookups_affected, 1)
})

test('another tenant or another job failures stay invisible', async () => {
  const d = await setup()
  audit(d, { tenantId: 't2', connector: 'enrich:apollo', jobId: 'j1', lookup: 'org X', status: 'auth', results: 0 })
  audit(d, { tenantId: 't1', connector: 'enrich:apollo', jobId: 'j2', lookup: 'org Y', status: 'auth', results: 0 })
  assert.deepEqual(await providerIssues('t1', 'j1'), [])
})

test('ok and empty outcomes are not provider failures', async () => {
  const d = await setup()
  audit(d, { tenantId: 't1', connector: 'enrich:apollo', jobId: 'j1', lookup: 'org Acme', status: 'ok', results: 2 })
  audit(d, { tenantId: 't1', connector: 'enrich:apollo', jobId: 'j1', lookup: 'org Beta', status: 'empty', results: 0 })
  assert.deepEqual(await providerIssues('t1', 'j1'), [])
})

test('unreadable audit table yields null, never a fabricated empty list', async () => {
  setDb(asDb(new Database(':memory:')))
  assert.equal(await providerIssues('t1', 'j1'), null)
})

test('issue text names the provider and the fix for a rejected key', () => {
  assert.equal(providerIssueText({ connector: 'enrich:apollo', status: 'auth', lookups_affected: 3, latest_at: 1 }), 'Apollo could not be used in this scan: the saved key was rejected. Check Settings > Enrichment.')
  assert.equal(providerIssueText({ connector: 'enrich:pdl', status: 'rate_limited', lookups_affected: 1, latest_at: 1 }), 'People Data Labs rate limit reached during this scan (1 lookup affected).')
})
