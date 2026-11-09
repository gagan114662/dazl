// #923: the run report's paid_enrichment stage reads the real writer connector namespace (enrich:apollo / enrich:pdl)
// and classifies every outcome; a failure row is never reported as a successful lookup.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateConnectors, audit } from '../lib/connectors/store.ts'
import { EnrichmentTrace, notePaidEnrichment, auditSummary } from '../lib/scan/enrichment-trace.ts'

const T = 't1', J = 'job1'
function db() { const d = new Database(':memory:'); migrateConnectors(d); return d }
function stage(d: Database.Database, job = J) { const tr = new EnrichmentTrace(); notePaidEnrichment(tr, d, T, job); return tr.stages.find(s => s.stage === 'paid_enrichment')! }

for (const connector of ['enrich:apollo', 'enrich:pdl']) {
  test(`#923 ${connector} ok lookup is reported ok, not unavailable`, () => {
    const d = db(); audit(d, { tenantId: T, connector, jobId: J, lookup: 'person x', status: 'ok', results: 1 })
    assert.equal(auditSummary(d, T, J, connector).withResults, 1)
    const s = stage(d)
    assert.equal(s.status, 'ok'); assert.equal(s.detail?.lookups, 1); assert.equal(s.detail?.with_results, 1)
  })
  test(`#923 ${connector} empty / held / failed are distinct`, () => {
    let d = db(); audit(d, { tenantId: T, connector, jobId: J, lookup: 'a', status: 'empty', results: 0 })
    assert.equal(stage(d).status, 'attempted_no_result')
    d = db(); audit(d, { tenantId: T, connector, jobId: J, lookup: 'a', status: 'credit_cap', results: 0 })
    assert.equal(stage(d).status, 'skipped')
    d = db(); audit(d, { tenantId: T, connector, jobId: J, lookup: 'a', status: 'name_mismatch', results: 0 })
    const f = stage(d); assert.equal(f.status, 'failed'); assert.equal(f.detail?.failed, 1); assert.equal(f.detail?.with_results, 0)
    d = db(); audit(d, { tenantId: T, connector, jobId: J, lookup: 'a', status: 'http_500', results: 0 })
    assert.equal(stage(d).status, 'failed')
  })
}

test('#923 negative controls: no lookup, other job, other tenant, non-paid connector -> unavailable', () => {
  const d = db()
  audit(d, { tenantId: T, connector: 'enrich:apollo', jobId: 'other', lookup: 'a', status: 'ok', results: 1 })
  audit(d, { tenantId: 't2', connector: 'enrich:pdl', jobId: J, lookup: 'a', status: 'ok', results: 1 })
  audit(d, { tenantId: T, connector: 'apollo-lookalike', jobId: J, lookup: 'a', status: 'ok', results: 1 })
  const s = stage(d); assert.equal(s.status, 'unavailable'); assert.equal(s.detail?.lookups, 0)
})

test('#923 unreadable audit is failed, not unavailable', () => {
  const d = new Database(':memory:') // no connector_audit table
  const s = stage(d); assert.equal(s.status, 'failed')
})

test('#923 a success alongside failures is ok but counts the failures truthfully', () => {
  const d = db()
  audit(d, { tenantId: T, connector: 'enrich:apollo', jobId: J, lookup: 'a', status: 'http_500', results: 0 })
  audit(d, { tenantId: T, connector: 'enrich:pdl', jobId: J, lookup: 'b', status: 'ok', results: 2 })
  const s = stage(d); assert.equal(s.status, 'ok'); assert.equal(s.detail?.failed, 1); assert.equal(s.detail?.lookups, 2)
})
