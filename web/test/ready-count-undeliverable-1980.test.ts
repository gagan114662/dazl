import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

if (process.env.DAZL_READY_1980_CHILD) {
  test('#1980 Home holds rejected, no-MX and candidate-verifier refusals', async () => {
    const { seedHomeReadyDeliverability } = await import('./helpers/home-ready-deliverability-1833-runtime.mts')
    const { homeReady } = await import('../lib/outreach/home-ready.ts')
    const db = seedHomeReadyDeliverability(true)
    try {
      const result = await homeReady('A')
      const byId = Object.fromEntries(result.companies.map(company => [company.lead_id, company]))
      assert.deepEqual(['rejected', 'nomx', 'candidate'].map(id => [id, byId[id]?.ready, byId[id]?.reason]), [
        ['rejected', false, "email can't receive mail"],
        ['nomx', false, "email can't receive mail"],
        ['candidate', false, "email can't receive mail"],
      ])
      assert.equal(byId.ok.ready, true, 'accepted mailbox control')
      assert.equal(byId.unknown.ready, true, 'unchecked mailbox control')
      assert.equal(byId.alternate.ready, true, 'accepted published alternate')
    } finally {
      db.close()
    }
  })
} else {
  test('#1980 a domain-only MX result cannot clear a mailbox rejection', async () => {
    const { deliverabilityBlocked } = await import('../lib/outreach/contact-route.ts')
    const email = 'rowan@workshop.example'
    const check = (value: string, retrieved_at: number) => ({ connector: 'scan:deliverability', kind: 'deliverability', value, retrieved_at })
    const rejected = check(`${email}|rejected`, 100)
    const domain = check('@workshop.example|mx_found', 101)
    assert.equal(deliverabilityBlocked(email, [rejected, domain]), true)
    assert.equal(deliverabilityBlocked(email, [rejected, domain, check(`${email}|accepted`, 102)]), false)
  })
  test('#1980 Ready holds and controls through the real Home store', () => {
    const env: NodeJS.ProcessEnv = { ...process.env, DAZL_READY_1980_CHILD: '1' }
    delete env.NODE_TEST_CONTEXT
    const result = spawnSync(process.execPath, [
      '--no-warnings', '--import', './test/helpers/net-fence.ts',
      '--loader', './test/helpers/scan-route-loader.mjs', '--test-reporter=tap',
      '--test', './test/ready-count-undeliverable-1980.test.ts',
    ], { cwd: new URL('../', import.meta.url), env, encoding: 'utf8', timeout: 120_000 })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /# pass 1/)
  })
}
