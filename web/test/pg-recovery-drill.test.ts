// scripts/backup/pg-backup.mts + pg-recovery-drill.mts (issue #360, part 3) on a synthetic Postgres database: a fresh
// database migrated with every PG migration, two encrypted secrets under a fresh master key, unresolved sends and a live
// lease. The drill passes with every secret decrypted and the counts reported; a wrong key, a modified dump, content that
// does not restore as recorded, and a missing sidecar fail; key-file guards refuse; no scratch database is left behind.
// Needs DAZL_TEST_PG_URL and pg_dump/pg_restore on PATH (the CI postgres job); skipped otherwise unless DAZL_REQUIRE_PG=1.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, chmodSync, copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { PG_URL } from './helpers/pg-test.ts'
import { runPgMigrations } from '../lib/db/migrate-pg.ts'
import { encryptSecret } from '../lib/secrets.ts'
import { fingerprint, type PgSidecar } from '../scripts/backup/pg-lib.ts'

const tools = spawnSync('pg_dump', ['--version']).status === 0 && spawnSync('pg_restore', ['--version']).status === 0
if (PG_URL && !tools && process.env.DAZL_REQUIRE_PG === '1') throw new Error('DAZL_REQUIRE_PG=1 but pg_dump/pg_restore are not on PATH')
const skip = !PG_URL ? 'DAZL_TEST_PG_URL not set' : !tools ? 'pg_dump/pg_restore not on PATH' : false
const web = fileURLToPath(new URL('../', import.meta.url))
const dbUrl = (name: string) => { const u = new URL(PG_URL!); u.pathname = '/' + name; return u.toString() }
const drills = async () => { const c = new pg.Client({ connectionString: PG_URL }); await c.connect(); try { return (await c.query("SELECT datname FROM pg_database WHERE datname LIKE 'dazl_drill_%'")).rowCount } finally { await c.end() } }

test('pg backup and recovery drill on a synthetic database', { skip }, async t => {
  const T = mkdtempSync(path.join(tmpdir(), 'pg-drill-'))
  const src = 'dazl_src_' + randomBytes(5).toString('hex')
  const admin = new pg.Client({ connectionString: PG_URL }); await admin.connect()
  await admin.query(`CREATE DATABASE ${src}`)
  const before = await drills()
  const key = randomBytes(32), keyFile = path.join(T, 'master.key')
  writeFileSync(keyFile, key.toString('base64') + '\n', { mode: 0o600 })
  try {
    const pool = new pg.Pool({ connectionString: dbUrl(src) })
    try {
      await runPgMigrations(pool)
      const tenant = 'tenant-' + randomBytes(4).toString('hex'), now = Math.floor(Date.now() / 1000)
      await pool.query("INSERT INTO tenant_llm_keys (tenant_id, vendor, ciphertext, last4, validated_at) VALUES ($1, 'anthropic', $2, 'abcd', $3)", [tenant, encryptSecret('sk-ant-api03-pg-drill-fixture', `llm-key:${tenant}:anthropic`, key), now])
      await pool.query("INSERT INTO gmail_accounts (tenant_id, email, refresh_ct) VALUES ($1, 'owner@staging.dazl.test', $2)", [tenant, encryptSecret('1//pg-drill-refresh-fixture', `gmail-refresh:${tenant}`, key)])
      const msg = "INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, claimed_at) VALUES ($1, $2, $3, 'x@staging.dazl.test', 'A quick question', 'A synthetic body long enough for the check.', $4, 1)"
      await pool.query(msg, [randomBytes(12).toString('hex'), tenant, 'l1', 'uncertain']); await pool.query(msg, [randomBytes(12).toString('hex'), tenant, 'l2', 'sending'])
      await pool.query("INSERT INTO app_leases (name, owner, expires_at) VALUES ('internal-tick', 'old-host', $1)", [now + 3600])
    } finally { await pool.end() }

    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT
    const node = (script: string, args: string[], extra: Record<string, string> = {}) => {
      const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', `scripts/backup/${script}`, ...args], { cwd: web, env: { ...env, ...extra }, encoding: 'utf8', timeout: 120_000 })
      return { code: r.status, out: r.stdout + r.stderr }
    }
    const b = node('pg-backup.mts', ['--dest', path.join(T, 'backups')], { DATABASE_URL: dbUrl(src) })
    assert.equal(b.code, 0, b.out)
    assert.ok(!b.out.includes(new URL(PG_URL!).password || '\u0000'), 'no password in the output')
    const dump = path.join(T, 'backups', readdirSync(path.join(T, 'backups')).find(f => f.endsWith('.dump'))!)
    const side = JSON.parse(readFileSync(dump + '.json', 'utf8')) as PgSidecar
    assert.equal(readFileSync(dump).subarray(0, 5).toString(), 'PGDMP', 'a pg_dump custom-format archive')
    assert.equal(statMode(dump), 0o600); assert.equal(statMode(dump + '.json'), 0o600)
    // the fingerprint is the source's content
    const sc = new pg.Client({ connectionString: dbUrl(src) }); await sc.connect()
    try { assert.deepEqual(side.tables, await fingerprint(sc)) } finally { await sc.end() }
    assert.equal(side.tables.tenant_llm_keys.rows, 1); assert.equal(side.tables.outreach_messages.rows, 2)

    const drill = (args: string[]) => node('pg-recovery-drill.mts', ['--admin-url', PG_URL!, ...args])

    await t.test('passes: content as recorded, every secret decrypts under the recovered key, send-safety counts', async () => {
      const report = path.join(T, 'report.json')
      const r = drill(['--backup', dump, '--key-file', keyFile, '--report', report])
      assert.equal(r.code, 0, r.out)
      const j = JSON.parse(readFileSync(report, 'utf8'))
      assert.equal(j.ok, true)
      assert.deepEqual(j.steps.map((s: { step: string }) => s.step), ['content', 'key recovery', 'send safety (reconcile before enabling sending)'])
      assert.deepEqual([j.steps[0].detail.missing, j.steps[0].detail.extra, j.steps[0].detail.differ, j.steps[0].detail.backup_unchanged], [[], [], [], true])
      assert.equal(j.steps[1].detail.total, 2); assert.equal(j.steps[1].detail.failed, 0)
      const d = j.steps[2].detail
      assert.deepEqual([d.messages_uncertain, d.messages_sending, d.leases_unexpired_at_drill], [1, 1, 1])
      assert.equal(typeof j.rpo_at_drill_s, 'number'); assert.ok(j.measured_rto_ms > 0)
      assert.match(j.app, /not checked: the app does not read Postgres yet/)
      for (const leak of ['sk-ant-api03', '1//pg-drill', key.toString('base64')]) assert.ok(!(r.out + readFileSync(report, 'utf8')).includes(leak), leak)
      assert.equal(await drills(), before, 'the scratch database is dropped')
    })

    await t.test('a wrong master key fails key recovery', async () => {
      const wrong = path.join(T, 'wrong.key'); writeFileSync(wrong, randomBytes(32).toString('base64'), { mode: 0o600 })
      const r = drill(['--backup', dump, '--key-file', wrong])
      assert.equal(r.code, 1); assert.match(r.out, /FAIL key recovery .*"failed":2/)
      assert.equal(await drills(), before)
    })

    await t.test('a dump modified after it was taken fails content before anything is restored', async () => {
      const copy = path.join(T, 'tampered.dump'); copyFileSync(dump, copy); copyFileSync(dump + '.json', copy + '.json'); appendFileSync(copy, 'x')
      const r = drill(['--backup', copy, '--key-file', keyFile])
      assert.equal(r.code, 1); assert.match(r.out, /FAIL content .*modified or truncated/)
      assert.equal(await drills(), before)
    })

    await t.test('content that does not restore as recorded fails and names the table', async () => {
      const copy = path.join(T, 'differ.dump'); copyFileSync(dump, copy)
      const s2 = { ...side, tables: { ...side.tables, outreach_messages: { rows: 3, md5: side.tables.outreach_messages.md5 } } }
      writeFileSync(copy + '.json', JSON.stringify(s2))
      const r = drill(['--backup', copy, '--key-file', keyFile])
      assert.equal(r.code, 1); assert.match(r.out, /FAIL content .*"differ":\["outreach_messages"\]/)
      assert.equal(await drills(), before)
    })

    await t.test('no sidecar: content cannot be verified, so it fails', async () => {
      const copy = path.join(T, 'bare.dump'); copyFileSync(dump, copy)
      const r = drill(['--backup', copy, '--key-file', keyFile])
      assert.equal(r.code, 1); assert.match(r.out, /FAIL content .*no dazl-pg-backup sidecar/)
    })

    await t.test('refuses: a key file others can read, a key of the wrong length, missing arguments', () => {
      const open = path.join(T, 'open.key'); writeFileSync(open, readFileSync(keyFile)); chmodSync(open, 0o644)
      assert.match(drill(['--backup', dump, '--key-file', open]).out, /chmod 600/)
      const short = path.join(T, 'short.key'); writeFileSync(short, randomBytes(16).toString('base64'), { mode: 0o600 })
      const r = drill(['--backup', dump, '--key-file', short]); assert.equal(r.code, 2); assert.match(r.out, /exactly 32 bytes/)
      assert.equal(node('pg-recovery-drill.mts', ['--backup', dump]).code, 2)
      assert.equal(node('pg-backup.mts', ['--dest', T], { DATABASE_URL: '' }).code, 2)
    })
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${src} WITH (FORCE)`); await admin.end()
    rmSync(T, { recursive: true, force: true })
  }
})
function statMode(f: string) { return statSync(f).mode & 0o777 }
