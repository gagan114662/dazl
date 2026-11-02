// Route-level proof for the scan-status transparency slice: REAL status route handler, fixture
// store seeded by scan-transparency-fixture.mts (raw scan handle + async Db layer point at the
// same in-memory SQLite), session identity switched per call (same harness as tenant-route-runtime).
// Asserts the serialized response carries provider_issues (this scan's provider failures only)
// and cost.per_verification_pass with honest unknowns. No network (fetch throws), no keys.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JOB_A, JOB_B, statusJson } from './scan-transparency-fixture.mts'

test('status response carries this scan provider failures, grouped, no lookup text', async () => {
  const { status, body: j } = await statusJson('A', 'Acme', JOB_A)
  assert.equal(status, 200)
  const issues = j.provider_issues as { connector: string; status: string; lookups_affected: number }[]
  assert.ok(Array.isArray(issues))
  const apolloAuth = issues.find(i => i.connector === 'enrich:apollo' && i.status === 'auth')
  assert.ok(apolloAuth); assert.equal(apolloAuth.lookups_affected, 1)
  const apolloRl = issues.find(i => i.connector === 'enrich:apollo' && i.status === 'rate_limited')
  assert.ok(apolloRl); assert.equal(apolloRl.lookups_affected, 1)
  const pdl = issues.find(i => i.connector === 'enrich:pdl')
  assert.ok(pdl); assert.equal(pdl.status, 'rate_limited')
  assert.equal(JSON.stringify(issues).includes('Acme'), false, 'lookup text must not leak into the response')
  // 'ok' rows are outcomes, not failures
  assert.equal(issues.some(i => i.status === 'ok'), false)
})

test('cost per verification pass: exact ratio with model-only scope label', async () => {
  const { body: j } = await statusJson('A', 'Acme', JOB_A)
  const p = (j.cost as { per_verification_pass: { verified: number; model_usd: number; usd_per_pass: number; unavailable: string | null }; model_scope: string }).per_verification_pass
  assert.ok(p, 'per_verification_pass present')
  assert.equal(p.verified, 4)
  assert.ok(Math.abs(p.model_usd - 0.45) < 1e-9, `model_usd ${p.model_usd}`)
  assert.ok(Math.abs(p.usd_per_pass - 0.1125) < 1e-9, `usd_per_pass ${p.usd_per_pass}`)
  assert.equal(p.unavailable, null)
  assert.match((j.cost as { model_scope: string }).model_scope, /not included/)
})

test('zero passes: no ratio, spend still visible; tenant B sees only its own job and issues', async () => {
  const { body: j } = await statusJson('B', 'Beta', JOB_B)
  const p = (j.cost as { per_verification_pass: { usd_per_pass: number | null; unavailable: string | null } }).per_verification_pass
  assert.equal(p.usd_per_pass, null)
  assert.equal(p.unavailable, 'no leads passed verification')
  const issues = j.provider_issues as { status: string }[]
  assert.equal(issues.length, 1)
  assert.equal(issues[0].status, 'auth')
  // B cannot read A's job at all (same 404 as missing)
  const r404 = await statusJson('B', 'Beta', JOB_A)
  assert.equal(r404.status, 404)
})
