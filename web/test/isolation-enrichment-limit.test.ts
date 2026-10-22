// F2 regression: the enrichment-write limiter is per tenant. Twenty writes from tenant A
// exhaust A's allowance but must not 429 tenant B, and the limiter cannot be invoked
// without a tenant id (the route authenticates before calling it - structural, since the
// helper takes userId). docs/security/tenant-isolation-assessment.md
import test from 'node:test'
import assert from 'node:assert/strict'
import { enrichmentWriteLimit } from '../lib/settings/enrichment-guard.ts'

test('one tenant exhausting their allowance does not block another tenant', () => {
  const a = 'limit-tenant-aaaaaaaa'
  const b = 'limit-tenant-bbbbbbbb'
  for (let i = 0; i < 20; i++) assert.equal(enrichmentWriteLimit(a).ok, true, `call ${i + 1} for A`)
  const blocked = enrichmentWriteLimit(a)
  assert.equal(blocked.ok, false)
  assert.ok(blocked.retryAfterS > 0)
  // Same instant, different tenant: unaffected.
  assert.equal(enrichmentWriteLimit(b).ok, true)
})
