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
