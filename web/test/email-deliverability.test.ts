import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const childFlag = 'DAZL_READY_1980_CHILD'

if (process.env[childFlag]) {
  test('#1980 the Ready and held lists display only the appropriate mailbox statuses', async t => {
    const { NextRequest } = await import('next/server')
    const { GET: homeReady } = await import('../app/api/home/ready/route.ts')
    const { GET: leads } = await import('../app/api/leads/route.ts')
    const { heldReason } = await import('../lib/journey.ts')
    const { holdWords } = await import('../lib/outreach/hold-words.ts')
    const { seedHomeReadyDeliverability } = await import('./helpers/home-ready-deliverability-1833-runtime.mts')
    const db = seedHomeReadyDeliverability(true)
    t.after(() => db.close())

    const homeResponse = await homeReady()
    assert.equal(homeResponse.status, 200)
    const home: import('../lib/outreach/home-ready.ts').HomeReady = await homeResponse.json()
    const readyIds = home.companies.filter(row => row.ready).map(row => row.lead_id)
    assert.equal(home.ready, 3)
    assert.deepEqual(readyIds.sort(), ['alternate', 'ok', 'unknown'])

    const reason = "email can't receive mail"
    const refusedRows = home.companies.filter(row => row.reason === reason)
    assert.deepEqual(refusedRows.map(row => row.lead_id).sort(), ['candidate', 'nomx', 'rejected'])
    assert.ok(refusedRows.every(row => !row.ready && row.details === undefined))
    const group = home.held.find(row => row.reason === reason)
    assert.equal(group?.count, 3)
    assert.equal(holdWords(reason, 1), "email can't receive mail")
    assert.ok(group?.job_id)

    const leadsResponse = await leads(new NextRequest(`http://test/api/leads?job_id=${group.job_id}`))
    assert.equal(leadsResponse.status, 200)
    const run: { leads: import('../lib/journey.ts').PreviewLead[] } = await leadsResponse.json()
    assert.deepEqual(Object.fromEntries(run.leads.map(row => [row.id, row.email_cannot_receive_mail])), {
      candidate: true, nomx: true, rejected: true, alternate: false, ok: false, unknown: false,
    })
    assert.deepEqual(Object.fromEntries(run.leads.map(row => [row.id, heldReason(row)])), {
      candidate: reason, nomx: reason, rejected: reason, alternate: null, ok: null, unknown: null,
    })
  })
} else {
  test('#1980 refused-mailbox status through the real Ready and Leads routes', () => {
    const env: NodeJS.ProcessEnv = { ...process.env, [childFlag]: '1' }
    delete env.NODE_TEST_CONTEXT
    const child = spawnSync(process.execPath, [
      '--no-warnings', '--import', './test/helpers/net-fence.ts',
      '--loader', './test/helpers/scan-route-loader.mjs', '--test-reporter=tap',
      '--test', './test/email-deliverability.test.ts',
    ], { cwd: new URL('../', import.meta.url), env, encoding: 'utf8', timeout: 120_000 })
    assert.equal(child.status, 0, child.stdout + child.stderr)
    assert.match(child.stdout, /# pass 1\b/)
  })
}
