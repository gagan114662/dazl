import test from 'node:test'
import assert from 'node:assert/strict'
import { scanOutcome } from '../lib/scan/scan-outcome.ts'

// Every stop that leaves a paid step possibly billed says: no automatic retry, it stays counted, a new scan may be charged again.
for (const error of ['accounting_failed', 'accounting_uncertain', 'provider_rate_limited', 'provider_rejected']) {
  test(`stop copy: ${error} warns that dazl did not retry and a new scan may be charged again`, () => {
    const o = scanOutcome({ id: 'j', status: 'failed', error, funded_by: 'user' } as never)
    assert.equal(o.kind, 'stopped')
    assert.match(o.detail ?? '', /did not (retry|run it again)/)
    assert.match(o.detail ?? '', /may be charged again/)
    assert.match(o.detail ?? '', /stays counted|stay counted/)
  })
}
