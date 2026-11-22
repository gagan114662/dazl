// #1036: the mailbox-check counter the enrichment settings show (verify-usage.ts) and the Postgres check of the crawl's unchecked-candidate
// selector (email-pattern.ts, the scan runner's path). Find work email itself runs no mailbox check (#1036 / #1250). Synthetic data, no
// providers; the SQL-compatibility check uses loopback Postgres.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { join } from 'node:path'
import pg from 'pg'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { runPgMigrations } from '../lib/db/migrate-pg.ts'
import { pgRejects, sqlSitesIn } from '../lib/db/sql-audit.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { reserveVerifySlot, VerifySlotRefused } from '../lib/people/email-pattern.ts'
import { mailboxCheckUsage } from '../lib/people/verify-usage.ts'
import { PG_URL, pgSkip, freshSchema } from './helpers/pg-test.ts'

const NOW = 1_800_000_000
const SITE = 'harbordental.example'
const seed = () => { const db = new Database(':memory:'); migrateAllSqlite(db); return { db } }

test('#1036 mailbox-check counter: honest when nothing can run (off, no verifier, caps 0), counts exactly what the cap counts, goes up by the checks made and stops at the cap', async () => {
  const s = seed(); const db = sqliteDb(s.db)
  const u = (env: Record<string, string>, now = NOW, tenant = 'A') => mailboxCheckUsage(db, tenant, env, now)
  const off = await u({}); assert.deepEqual([off.state, off.verifier, off.day.used, off.day.cap, off.month.used], ['off', null, 0, 0, 0]); assert.match(off.note, /no mailbox check runs and none is counted/)
  assert.equal((await u({ EMAIL_GUESS_ENABLED: '1' })).state, 'no_verifier')
  const fake = { EMAIL_GUESS_ENABLED: '1', DAZL_ENV: 'staging', DAZL_STAGING_FAKE_ZEROBOUNCE: '1' }
  assert.equal((await u(fake)).state, 'daily_cap_zero'); assert.equal((await u({ ...fake, EMAIL_VERIFY_DAILY_CAP: '3' })).verifier, 'zerobounce-staging-fake')
  assert.equal((await u({ ...fake, EMAIL_VERIFY_DAILY_CAP: '3', EMAIL_VERIFY_MONTHLY_CAP: '0' })).state, 'monthly_cap_zero')
  const env = { ...fake, EMAIL_VERIFY_DAILY_CAP: '3', EMAIL_VERIFY_MONTHLY_CAP: '10' }
  const first = await u(env); assert.deepEqual([first.state, first.day, first.month.cap], ['active', { used: 0, cap: 3, remaining: 3 }, 10])
  // three checks, each reserved through the real cap: the counter goes up by exactly one each time and the fourth is refused
  const reserve = (i: number) => reserveVerifySlot(s.db, { tenantId: 'A', verifier: 'zerobounce-staging-fake', nowS: NOW, dailyCap: 3, monthCap: 10 }, () => s.db.prepare("INSERT INTO email_candidates (tenant_id, lead_id, person, address, format, country_basis, tier, checked_at, verification, verifier) VALUES ('A', 'l', 'P', ?, 'first.last', 'b', 'guessed', ?, 'pending', 'zerobounce-staging-fake')").run(`p${i}@${SITE}`, NOW).changes === 1)
  for (let i = 1; i <= 3; i++) { await reserve(i); const x = await u(env); assert.deepEqual([x.day.used, x.day.remaining, x.month.used], [i, 3 - i, i]) }
  await assert.rejects(() => reserve(4), (e: unknown) => e instanceof VerifySlotRefused)
  const spent = await u(env); assert.deepEqual([spent.state, spent.day.used, spent.day.remaining], ['day_spent', 3, 0])
  assert.equal((await u(env, NOW + 86_400)).state, 'active', 'the next UTC day: the daily count starts again')
  // a work-email lookup's mailbox check counts too, and another tenant's checks never do
  s.db.prepare("INSERT INTO work_email_lookups (tenant_id, lead_id, target, status, provider, address, mailbox_check, mailbox_verifier, mailbox_checked_at, updated_at) VALUES ('B', 'x', 'Q R|Owner', 'unverified', 'pdl', 'q@b.example', 'valid', 'zerobounce-staging-fake', ?, ?)").run(NOW, NOW)
  assert.equal((await u(env)).day.used, 3, "tenant B's check is not tenant A's")
  assert.equal((await u(env, NOW, 'B')).day.used, 1)
  assert.equal((await u({ ...env, EMAIL_VERIFY_MONTHLY_CAP: '3' })).state, 'month_spent')
})

test('Postgres prepares the exact production SQL for selecting unchecked work-email candidates', { skip: pgSkip }, async () => {
  const root = join(import.meta.dirname, '..')
  const sites = sqlSitesIn(join(root, 'lib', 'people', 'email-pattern.ts'), root)
    .filter(site => site.sql.startsWith('SELECT address FROM email_candidates WHERE tenant_id =') && site.sql.includes("verification = 'none'"))
  assert.equal(sites.length, 1, 'the production candidate selector must be part of this test')
  assert.equal(sites[0].dynamic, false, "the production candidate selector must be statically auditable")
  const schema = await freshSchema()
  const pool = new pg.Pool({ connectionString: PG_URL, max: 1, options: `-c search_path=${schema.schema}` })
  try {
    await runPgMigrations(pool)
    const client = await pool.connect()
    try {
      const rejects = await pgRejects(client, sites)
      assert.deepEqual(rejects.map(reject => reject.error), [])
    } finally { client.release() }
  } finally { await pool.end(); await schema.drop() }
})
