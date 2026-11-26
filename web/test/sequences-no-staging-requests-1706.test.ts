// #1706, Ziggy's send-back on PR #1759: the Follow-ups page must make NO staging-only requests.
// The fixture route exists only in staging builds (route.staging.ts, and its handlers 404 unless
// DAZL_ENV is staging); the page used to GET it on every load just to ask whether the test fixture
// exists. Now the production sequences GET carries fixture_available, gated exactly as the staging
// route gates it, and the page reads that. The fixture CREATE buttons remain, behind the staging
// build flag, as explicit clicks — never a page-load request.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { migrateSequences, setTestAddresses } from '../lib/outreach/sequences.ts'
import { fixtureAvailable, fixtureEligible } from '../lib/outreach/test-fixture.ts'
import { TEST_INBOX } from '../lib/outreach/service.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { oldestDue } from '../lib/ops/scheduler-runs.ts'

const client = readFileSync(new URL('../app/app/outreach/sequences-client.tsx', import.meta.url), 'utf8')
const route = readFileSync(new URL('../app/api/outreach/sequences/route.ts', import.meta.url), 'utf8')
const pgReader = readFileSync(new URL('../lib/db/leads-read-pg.ts', import.meta.url), 'utf8')

test('the page never fetches the staging-only fixture route', () => {
  assert.ok(!client.includes("fetch('/api/outreach/sequences/fixture')"), 'no direct GET of the fixture route anywhere in the page')
  assert.ok(!/\.then\(.*fixture/.test(client), 'no chained fixture read either')
  const loadStart = client.indexOf('async function load()')
  const load = client.slice(loadStart, client.indexOf('useEffect', loadStart))
  assert.ok(!load.includes('sequences/fixture'), 'load() never calls the fixture route path')
  assert.ok(load.includes('fixture_eligible'), 'load() takes eligibility from the sequences response')
})

test('the production sequences route carries the availability, gated as staging-only', () => {
  assert.ok(route.includes('fixture_available'), 'the GET response carries fixture_available')
  assert.ok(route.includes("process.env.DAZL_ENV === 'staging' && fixtureAvailable(db, user.tenantId)"), 'gated on staging AND the designated-account check, the same gate as the staging route')
})

test('fixtureAvailable itself: only the designated tenant with the designated inbox allowlisted', () => {
  const db = new Database(':memory:')
  migrateSequences(db)
  const prev = process.env.OUTREACH_TEST_TENANT_ID
  try {
    delete process.env.OUTREACH_TEST_TENANT_ID
    setTestAddresses(db, 'A', [TEST_INBOX])
    assert.equal(fixtureAvailable(db, 'A'), false, 'no designated tenant in the env: not available')
    process.env.OUTREACH_TEST_TENANT_ID = 'B'
    assert.equal(fixtureAvailable(db, 'A'), false, 'a different tenant is designated: not available')
    process.env.OUTREACH_TEST_TENANT_ID = 'A'
    assert.equal(fixtureAvailable(db, 'A'), true, 'designated tenant with the test inbox saved: available')
    setTestAddresses(db, 'A', [])
    assert.equal(fixtureAvailable(db, 'A'), false, 'designated tenant without the inbox saved: not available')
  } finally {
    if (prev === undefined) delete process.env.OUTREACH_TEST_TENANT_ID; else process.env.OUTREACH_TEST_TENANT_ID = prev
  }
})

test('setup can always start: editing is gated on eligibility (designated account), not on availability (Capy 1)', () => {
  const prev = process.env.OUTREACH_TEST_TENANT_ID
  try {
    delete process.env.OUTREACH_TEST_TENANT_ID
    assert.equal(fixtureEligible('A'), false, 'no designated tenant in the env: nobody is eligible')
    process.env.OUTREACH_TEST_TENANT_ID = 'A'
    assert.equal(fixtureEligible('A'), true, 'the designated account is eligible with a completely empty list — it can open the editor and add the inbox')
    assert.equal(fixtureEligible('B'), false, 'any other account is not eligible')
  } finally {
    if (prev === undefined) delete process.env.OUTREACH_TEST_TENANT_ID; else process.env.OUTREACH_TEST_TENANT_ID = prev
  }
  // The page gates the editor and the minute-follow-up panel on eligibility alone (Capy 1 and 3):
  // never on availability, and ordinary accounts never see minute-follow-up copy.
  assert.ok(route.includes('fixture_eligible: fixtureEligible(user.tenantId)'), 'the route carries server-checked eligibility')
  assert.ok(client.includes('setFixtureEligible(j.fixture_eligible === true)'), 'the page reads eligibility from the response')
  assert.ok(client.includes('{fixtureEligible&&<details'), 'the allowlist editor opens for the designated account before anything is saved')
  assert.ok(client.includes('{fixtureEligible&&data&&data.test_addresses.length>0'), 'the saved-inboxes panel (minute follow-ups) shows only to the designated account')
  assert.ok(!client.includes('{!fixtureAvailable&&data&&data.test_addresses.length>0'), 'the old availability-gated panel is gone')
})

test('the two timing readers apply the same designation gate as runSequences (Capy 2)', async () => {
  const NOW = 1_900_000_000
  const seed = (db: Database.Database, tenant: string) => {
    db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at) VALUES ('m1', ?, 'l1', 'x@co.example', 'Subject here', 'A body long enough for the check.', 'sent', ?)").run(tenant, NOW - 600)
    db.prepare("INSERT INTO sequences (id, tenant_id, lead_id, message_id, to_email, status) VALUES ('s1', ?, 'l1', 'm1', 'x@co.example', 'active')").run(tenant)
    db.prepare("INSERT INTO sequence_settings (tenant_id, test_addresses) VALUES (?, ?)").run(tenant, JSON.stringify(['x@co.example']))
  }
  const prev = process.env.OUTREACH_TEST_TENANT_ID
  try {
    // Ordinary account with the recipient in its saved list: step 2 is due in 3 DAYS, not 3 minutes.
    const dbA = new Database(':memory:'); migrateAllSqlite(dbA); seed(dbA, 'A')
    process.env.OUTREACH_TEST_TENANT_ID = 'ZZZ'
    assert.equal(await oldestDue(dbA as never, 'A', NOW), null, 'oldestDue: an ordinary account saved list does not shorten the gap')
    // The designated account: the same seed is due after the 3-minute test gap.
    const dbB = new Database(':memory:'); migrateAllSqlite(dbB); seed(dbB, 'B')
    process.env.OUTREACH_TEST_TENANT_ID = 'B'
    const due = await oldestDue(dbB as never, 'B', NOW)
    assert.equal(due?.due_at, NOW - 600 + 180, 'oldestDue: the designated account keeps the minute gap')
  } finally {
    if (prev === undefined) delete process.env.OUTREACH_TEST_TENANT_ID; else process.env.OUTREACH_TEST_TENANT_ID = prev
  }
  // The pg reader cannot run here (no Postgres), so its gate is pinned in source, mirroring the sqlite one.
  assert.ok(pgReader.includes('const isDesignatedTestTenant = !!process.env.OUTREACH_TEST_TENANT_ID && process.env.OUTREACH_TEST_TENANT_ID === tenantId'), 'leads-read-pg computes the designation')
  assert.ok(pgReader.includes('isDesignatedTestTenant && testList.includes(norm(r.to_email)) ? TEST_GAPS_S : GAPS_S'), 'leads-read-pg gates the test gaps on it')
})
