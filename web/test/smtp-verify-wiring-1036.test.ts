// #1036 dazl's own mailbox check wired through the two existing callers - the scan's guessed addresses (verifyCandidates) and Find
// work email's checkMailbox - with the staging fake SMTP server (no network; the REAL verifier code runs against scripted answers).
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { saveCredential } from '../lib/connectors/store.ts'
import { setTestAddresses } from '../lib/outreach/sequences.ts'
import { TEST_INBOX } from '../lib/outreach/service.ts'
import { migrateEmailGuess, verifierFromEnv, verifyCandidates } from '../lib/people/email-pattern.ts'
import { findWorkEmail, workEmailProviders, workEmailsFor } from '../lib/people/work-email.ts'
import { workEmailCopy } from '../lib/people/work-email-eligible.ts'
import { createWorkEmailFixture, WORK_EMAIL_FIXTURE_PEOPLE } from '../lib/scan/work-email-fixture.ts'

const T = 'smtp-wiring-tenant'
const SMTP_FAKE = { DAZL_ENV: 'staging', DAZL_STAGING_FAKE_SMTP: '1', EMAIL_GUESS_ENABLED: '1', EMAIL_VERIFY_DAILY_CAP: '10' }

function guessed() {
  const db = new Database(':memory:'); migrateAllSqlite(db); migrateEmailGuess(db)
  const add = db.prepare("INSERT INTO email_candidates (tenant_id, lead_id, person, address, format, country_basis, tier, confidence) VALUES (?, 'L1', ?, ?, 'first.last', 'homepage address: Austin, TX 78701', 'guessed', 'high')")
  add.run(T, 'Dana Lee, CEO', 'dana.lee@acme.test'); add.run(T, 'Ben Nouser, CFO', 'ben.nouser@acme.test'); add.run(T, 'Cara Diaz, COO', 'cara.diaz@catchall.test')
  return db
}
const states = (db: Database.Database) => Object.fromEntries((db.prepare("SELECT address, verification, verifier FROM email_candidates ORDER BY address").all() as { address: string; verification: string; verifier: string }[]).map(r => [r.address, `${r.verification}/${r.verifier}`]))

test('#1036 scan guesses through dazl\'s own check: 250 = verified, 550 = undeliverable, a catch-all domain = catch_all (never verified); each check counted in the ledger under the verifier\'s name', async () => {
  const db = guessed(); const v = verifierFromEnv(SMTP_FAKE, undefined, db)
  assert.equal(v?.name, 'smtp-staging-fake')
  const run = await verifyCandidates(db, T, 'L1', v, { env: SMTP_FAKE })
  assert.deepEqual([run.checked, run.verified], [3, 1])
  assert.deepEqual(states(db), { 'ben.nouser@acme.test': 'undeliverable/smtp-staging-fake', 'cara.diaz@catchall.test': 'catch_all/smtp-staging-fake', 'dana.lee@acme.test': 'verified/smtp-staging-fake' })
  assert.equal((db.prepare("SELECT n FROM email_verify_usage WHERE verifier = 'smtp-staging-fake'").get() as { n: number }).n, 3)
})

test('#1036 the SMTP monthly cap is its own (SMTP_VERIFY_MONTHLY_CAP) and stops the checks; 0 turns them off visibly', async () => {
  const db = guessed(); const env = { ...SMTP_FAKE, SMTP_VERIFY_MONTHLY_CAP: '2' }
  const run = await verifyCandidates(db, T, 'L1', verifierFromEnv(env, undefined, db), { env })
  assert.deepEqual([run.checked, run.capped], [2, 1], 'two checks, then the cap')
  const off = await verifyCandidates(guessed(), T, 'L1', verifierFromEnv({ ...SMTP_FAKE, SMTP_VERIFY_MONTHLY_CAP: '0' }, undefined, db), { env: { ...SMTP_FAKE, SMTP_VERIFY_MONTHLY_CAP: '0' } })
  assert.match(String(off.skipped), /SMTP_VERIFY_MONTHLY_CAP is 0/)
})

test('#1036 Find work email: the fake PDL finds the address, dazl\'s own check confirms it, and the panel says who checked it', async () => {
  const db = new Database(':memory:'); migrateAllSqlite(db); const master = randomBytes(32)
  process.env.OUTREACH_TEST_TENANT_ID = T; setTestAddresses(db, T, [TEST_INBOX]); saveCredential(db, T, 'enrich:pdl', 'staging-fake-pdl-any-string-1036', master)
  const env = { ...SMTP_FAKE, DAZL_STAGING_FAKE_PDL: '1', DAZL_STAGING_FAKE_ZEROBOUNCE: '1' } // both fakes on: dazl's own check goes first
  const f = createWorkEmailFixture(db, T, env)
  assert.equal(workEmailProviders(db, T, env).mailboxCheck, true)
  const run = (name: string) => { const p = WORK_EMAIL_FIXTURE_PEOPLE.find(x => x.name === name)!; return findWorkEmail(db, T, f.leadId, `${p.name}|${p.title}`, { master, env, fetchImpl: (async () => { throw new Error('no network') }) as typeof fetch }) }
  const row = (r: Awaited<ReturnType<typeof run>>) => (r as { row: Parameters<typeof workEmailCopy>[0] }).row
  const valid = await run('Valid Testbuyer')
  assert.deepEqual([row(valid).mailbox_check, row(valid).mailbox_verifier], ['valid', 'smtp-staging-fake'])
  const c = workEmailCopy(row(valid)); assert.equal(c.headline, 'Checked work email'); assert.match(c.note, /STAGING TEST mailbox check \(not a real check\)/)
  const invalid = await run('Invalid Testbuyer')
  assert.equal(row(invalid).mailbox_check, 'undeliverable'); assert.equal(row(invalid).address, null, 'an address the server says does not exist is never sent to the browser')
  assert.equal(workEmailsFor(db, T, f.leadId).find(r => r.target.startsWith('Invalid'))?.address, null)
  assert.equal((db.prepare("SELECT n FROM email_verify_usage WHERE verifier = 'smtp-staging-fake'").get() as { n: number }).n, 2)
})

// Hermes 2026-11-14: a check that cannot run costs nothing. Port 25 shut (the box's state until AWS opens it) must not use the monthly
// allowance, must not mark anything checked, and must not count against the tenant's day.
const shutPort25 = (db: Database.Database) => db.prepare("INSERT OR REPLACE INTO smtp_verify_state (k, n, hold_until, v, updated_at) VALUES ('p25', 3, NULL, NULL, ?)").run(Math.floor(Date.now() / 1000))
const used = (db: Database.Database) => (db.prepare("SELECT COALESCE(SUM(n), 0) AS n FROM email_verify_usage WHERE verifier = 'smtp-staging-fake'").get() as { n: number }).n

test('#1036 port 25 shut: the scan\'s guesses are not reserved, marked or counted; the run says why it stopped', async () => {
  const db = guessed(); shutPort25(db); const v = verifierFromEnv(SMTP_FAKE, undefined, db)
  assert.match(v?.blockedNow?.() ?? '', /port 25 appears to be shut/)
  const run = await verifyCandidates(db, T, 'L1', v, { env: SMTP_FAKE })
  assert.equal(run.checked, 0); assert.match(run.stopped ?? '', /port 25/)
  assert.equal(used(db), 0, 'no allowance used')
  assert.equal((db.prepare("SELECT count(*) AS n FROM email_candidates WHERE verification = 'none'").get() as { n: number }).n, 3, 'every address is still unchecked')
  assert.equal((db.prepare('SELECT count(*) AS n FROM email_candidates WHERE checked_at IS NOT NULL').get() as { n: number }).n, 0, 'nothing counts against the tenant\'s day')
})

test('#1036 a check that makes no connection (a backoff already in force) gives its allowance back and leaves the address unchecked', async () => {
  const db = guessed(); const v = verifierFromEnv(SMTP_FAKE, undefined, db)!
  const a = await v.verify('dana.lee@acme.test') // learns the MX, makes the dialog
  assert.equal(a.outcome, 'deliverable')
  db.prepare("INSERT OR REPLACE INTO smtp_verify_state (k, n, hold_until, v, updated_at) SELECT 'bo:' || json_extract(v, '$.mx'), 1, ?, NULL, ? FROM smtp_verify_state WHERE k = 'dom:acme.test'").run(Math.floor(Date.now() / 1000) + 600, Math.floor(Date.now() / 1000))
  const run = await verifyCandidates(db, T, 'L1', v, { env: SMTP_FAKE })
  const left = Object.fromEntries((db.prepare('SELECT address, verification, checked_at FROM email_candidates').all() as { address: string; verification: string; checked_at: number | null }[]).map(r => [r.address, r]))
  assert.deepEqual([left['dana.lee@acme.test'].verification, left['dana.lee@acme.test'].checked_at, left['ben.nouser@acme.test'].verification, left['ben.nouser@acme.test'].checked_at], ['none', null, 'none', null], 'the two backed-off addresses are unchecked and uncounted for the tenant')
  assert.equal(left['cara.diaz@catchall.test'].verification, 'catch_all', 'a different server was not backed off and was checked')
  assert.equal(run.checked, 1)
  assert.equal(used(db), 1, 'only the catch-all domain\'s own check counted; the two backed-off tries were refunded')
})

test('#1036 port 25 shut: Find work email\'s mailbox check reserves nothing and the row stays "found, not checked"', async () => {
  const db = new Database(':memory:'); migrateAllSqlite(db); const master = randomBytes(32)
  process.env.OUTREACH_TEST_TENANT_ID = T; setTestAddresses(db, T, [TEST_INBOX]); saveCredential(db, T, 'enrich:pdl', 'staging-fake-pdl-any-string-1036', master)
  const env = { ...SMTP_FAKE, DAZL_STAGING_FAKE_PDL: '1', DAZL_STAGING_FAKE_ZEROBOUNCE: '1' }
  const f = createWorkEmailFixture(db, T, env); shutPort25(db)
  const p = WORK_EMAIL_FIXTURE_PEOPLE.find(x => x.name === 'Valid Testbuyer')!
  const r = await findWorkEmail(db, T, f.leadId, `${p.name}|${p.title}`, { master, env, fetchImpl: (async () => { throw new Error('no network') }) as typeof fetch }) as { row: { mailbox_check: string | null; address: string | null } }
  assert.equal(r.row.mailbox_check ?? null, null, 'not checked: nothing implies a verified address')
  assert.ok(r.row.address, 'the found address is still shown as found')
  assert.equal(used(db), 0)
})
