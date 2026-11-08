// Route boundary for /api/scan/icp: the preview's spend and provider failures keep their truthful names and statuses
// (the same mapping as the website profile read), never a blanket 402 "key_rejected". previewIcp is stubbed at the
// module boundary; no runner, no network, no provider.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb } from './sequence-route-db.ts'
import { setAuthDb } from './scan-route-auth-db.ts'
import { migrateScan } from '../../lib/scan/store.ts'
import { setPreviewIcp } from './scan-route-stub-runner.ts'
import { POST } from '../../app/api/scan/icp/route.ts'

const request = (body: unknown) => new NextRequest('http://localhost/api/scan/icp', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' }, body: JSON.stringify(body),
})

test('POST /api/scan/icp: spend and provider failures map to their own names and statuses', async () => {
  const db = new Database(':memory:')
  try {
    migrateScan(db)
    setScanDb(db); setAuthDb(db)
    const cases: [Record<string, unknown>, number, string][] = [
      [{ error: 'spend_limit' }, 429, 'spend_limit'],
      [{ error: 'model_unpriced' }, 503, 'model_unpriced'],
      [{ error: 'accounting_pending' }, 503, 'accounting_pending'],
      [{ error: 'spend_unavailable' }, 503, 'spend_unavailable'],
      [{ error: 'provider_failed' }, 502, 'provider_failed'],
      [{ error: 'key_rejected' }, 402, 'key_rejected'],
      [{ error: 'key_unreadable' }, 400, 'key_unreadable'],
      [{ error: 'no_api_key' }, 400, 'no_api_key'],
      [{ error: 'trial_key_invalid' }, 503, 'trial_key_invalid'],
    ]
    for (const [out, status, name] of cases) {
      setPreviewIcp(async () => out as never)
      const r = await POST(request({ query: 'fintech founders in Europe' }))
      const j = await r.json() as { error?: string; message?: string }
      assert.equal(r.status, status, `${name}: ${JSON.stringify(j)}`)
      assert.equal(j.error, name)
      if (name === 'spend_limit' || name === 'model_unpriced' || name === 'accounting_pending' || name === 'spend_unavailable') {
        assert.ok(typeof j.message === 'string' && /nothing was charged|no new charge/i.test(j.message), `${name}: honest no-charge copy`)
        assert.ok(!/key was rejected|rejected your key|invalid key/i.test(j.message!), `${name}: never mislabeled as a key problem`)
      }
      if (name === 'provider_failed') assert.ok(/key was not rejected/i.test(j.message ?? ''), 'provider_failed: says the key is fine')
    }
    // A good preview still passes through.
    setPreviewIcp(async () => ({ icp: { summary: 'Fintech founders', who: ['Founder'], industries: [], sizes: [], where: [], signals: [], exclude: [] }, inferred: true }) as never)
    const ok = await POST(request({ query: 'fintech founders in Europe' }))
    assert.equal(ok.status, 200)
    assert.equal((await ok.json() as { inferred?: boolean }).inferred, true)
  } finally { setPreviewIcp(null); db.close() }
})
