// Release gate for the SQLite schema (issue #362; .github/workflows/release-gate.yml). Production runs SQLite and every
// release migrates its database at startup (lib/db/sqlite-migrations.ts), so a release must be able to:
//   1. forward: open a database the previous release created and filled, and keep every row it had, by key, with every
//      value it had in every column it had (new columns may be added; a value may change only if EXPECTED_CHANGES below
//      names that table and column), then read it with its own code: the demo password verifies, the stored API key
//      decrypts to the value written;
//   2. re-run: migrate the same database again and change nothing at all (schema and every value; every restart does it);
//   3. roll back: the previous release migrates the new database without changing any value and its own code still
//      signs the demo user in and decrypts the key (deploy.sh and DEPLOY.md "Rollback" put it back on the same file).
//      With --keep DIR the migrated database and its synthetic env are left in DIR for scripts/rollback-start-check.mjs,
//      which starts the previous release's real production build on it (CI does both).
// Each step runs in its own process with that release's own code. The previous release's database is filled by its own
// staging seed plus one stored API key (synthetic: a demo account, scans, leads, a stub Gmail connection, a made-up key
// encrypted under a throwaway master key; no real data, nothing leaves the machine).
//   node --experimental-strip-types scripts/migration-gate.mts <previous release web dir> [<new release web dir>] [--keep DIR]
// The new release defaults to this checkout. The previous release's directory needs node_modules (CI links this one's).
// Exit 0 = all three hold; exit 1 names the failed step and the first differences.
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Values a migration is allowed to change in rows the previous release wrote: { table: [column, ...] }. A migration that
// rewrites values (a backfill that normalises, a re-encryption) lists them here in the same PR, so the change is reviewed.
export const EXPECTED_CHANGES: Record<string, string[]> = {}

const args = process.argv.slice(2)
const keepAt = args.indexOf('--keep')
const keep = keepAt >= 0 ? path.resolve(args.splice(keepAt, 2)[1] ?? '') : null
const [prevArg, nextArg] = args
if (!prevArg) { console.error('usage: migration-gate.mts <previous release web dir> [<new release web dir>] [--keep DIR]'); process.exit(2) }
const prev = path.resolve(prevArg)
const next = path.resolve(nextArg ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'))
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-migration-gate-'))
const DB_PATH = path.join(tmp, 'app.db')
// one synthetic identity for every step, so the next release and the rollback read what the previous one wrote
const SYNTH = {
  DAZL_MASTER_KEY: randomBytes(32).toString('base64'),
  STAGING_DEMO_PASSWORD: randomBytes(12).toString('hex'),
  GATE_API_KEY: 'sk-ant-api03-synthetic-' + randomBytes(16).toString('hex'),
}

// One step in a child process, run with `dir`'s code: migrate, optionally seed, optionally read through the app's own
// functions, then a snapshot on stdout: schema, every row of every table (keyed by primary key, else rowid), integrity.
const STEP = `
import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { scryptSync, timingSafeEqual } from 'node:crypto'
const [dir, db_path, mode] = process.argv.slice(1)
const has = p => existsSync(dir + '/' + p)
const { migrateAllSqlite } = await import(dir + '/lib/db/sqlite-migrations.ts')
const raw = new Database(db_path)
migrateAllSqlite(raw)
const notes = []
const master = Buffer.from(process.env.DAZL_MASTER_KEY, 'base64')
if (mode === 'seed') {
  const { seedStaging } = await import(dir + '/scripts/staging-seed.mts')
  const { tenant } = await seedStaging(raw, process.env.STAGING_DEMO_PASSWORD)
  if (has('lib/llm/key-store.ts')) (await import(dir + '/lib/llm/key-store.ts')).saveKey(raw, tenant, 'anthropic', process.env.GATE_API_KEY, master)
  else notes.push('no key store: no stored key seeded')
}
if (mode === 'read') {
  // the app's own reads: the password sign-in lookup and the scan runner's key decryption
  const email = has('scripts/staging-seed.mts') ? (await import(dir + '/scripts/staging-seed.mts')).DEMO_EMAIL : null
  if (email && has('lib/auth-db.ts') && has('lib/db/client.ts')) {
    const { findPasswordUser } = await import(dir + '/lib/auth-db.ts')
    const { sqliteDb } = await import(dir + '/lib/db/client.ts')
    const u = await findPasswordUser(email, sqliteDb(raw))
    if (!u) throw new Error('read: the demo user is not found by the sign-in lookup')
    if (!timingSafeEqual(scryptSync(process.env.STAGING_DEMO_PASSWORD, u.salt, 64), Buffer.from(u.password_hash, 'hex'))) throw new Error('read: the demo password no longer verifies')
    if (has('lib/llm/key-store.ts')) {
      let got
      try { got = (await import(dir + '/lib/llm/key-store.ts')).getKey(raw, u.id, 'anthropic', master) }
      catch (e) { throw new Error('read: the stored API key does not decrypt (' + (e?.message ?? e) + ')') }
      if (got !== process.env.GATE_API_KEY) throw new Error('read: the stored API key does not decrypt to the value written')
      notes.push('demo password verifies, stored key decrypts')
    } else notes.push('demo password verifies (no key store)')
  } else notes.push('no auth/seed modules: app reads not checked')
}
const objects = raw.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()
const q = n => '"' + n.replaceAll('"', '""') + '"'
const val = v => Buffer.isBuffer(v) ? { blob: v.toString('hex') } : typeof v === 'bigint' ? { int: String(v) } : v
const rows = {}
for (const t of objects.filter(o => o.type === 'table')) {
  const cols = raw.prepare('PRAGMA table_info(' + q(t.name) + ')').all()
  const pk = cols.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => c.name)
  const withoutRowid = /WITHOUT\\s+ROWID/i.test(t.sql ?? '')
  const all = raw.prepare('SELECT ' + (withoutRowid ? '' : 'rowid AS "__rowid", ') + '* FROM ' + q(t.name)).safeIntegers().all()
  const out = {}
  for (const r of all) {
    const key = JSON.stringify(pk.length ? pk.map(c => val(r[c])) : [val(r.__rowid)])
    delete r.__rowid
    out[key] = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, val(v)]))
  }
  rows[t.name] = out
}
const integrity = raw.prepare('PRAGMA integrity_check').pluck().all()
const fk = raw.prepare('PRAGMA foreign_key_check').all()
raw.close()
process.stdout.write(JSON.stringify({ objects, rows, integrity, fk, notes }))
`
type Row = Record<string, unknown>
type Snap = { objects: { type: string; name: string; sql: string | null }[]; rows: Record<string, Record<string, Row>>; integrity: string[]; fk: unknown[]; notes: string[] }
function step(name: string, dir: string, mode: 'seed' | 'read' | 'migrate'): Snap {
  if (!existsSync(path.join(dir, 'lib/db/sqlite-migrations.ts'))) fail(name, `${dir} has no lib/db/sqlite-migrations.ts`)
  if (mode === 'seed' && !existsSync(path.join(dir, 'scripts/staging-seed.mts'))) fail(name, `${dir} has no scripts/staging-seed.mts to fill the database with`)
  // The child imports better-sqlite3 from `dir`, so it runs there with that release's node_modules.
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', STEP, dir, DB_PATH, mode], {
    cwd: dir, encoding: 'utf8', timeout: 120_000, maxBuffer: 256 * 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, DB_PATH, DAZL_ENV: 'staging', PUBLIC_BASE_URL: 'https://staging.example.test', ...SYNTH } as unknown as NodeJS.ProcessEnv,
  })
  if (r.status !== 0) {
    const out = (r.stderr || r.stdout || String(r.error)).trim().split('\n')
    fail(name, out.find(l => /^\s*(\w*Error|error:)|^Error\b|Error:/.test(l))?.trim() ?? out.slice(-5).join('\n'))
  }
  const snap = JSON.parse(r.stdout) as Snap
  if (snap.integrity.join() !== 'ok') fail(name, `integrity_check: ${snap.integrity.join('; ')}`)
  if (snap.fk.length) fail(name, `foreign_key_check: ${snap.fk.length} violation(s)`)
  return snap
}
function fail(name: string, why: string): never {
  console.error(`migration-gate: FAIL ${name}: ${why}`)
  rmSync(tmp, { recursive: true, force: true }); process.exit(1)
}
const count = (s: Snap) => Object.values(s.rows).reduce((a, t) => a + Object.keys(t).length, 0)
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
// Every row of `before`, by key, is in `after` with the same value in every column `before` had (EXPECTED_CHANGES
// aside when `allowed`). Rows and columns `after` adds are fine. Returns the first differences, empty when preserved.
function differences(before: Snap, after: Snap, allowed: Record<string, string[]>): string[] {
  const out: string[] = []
  for (const [table, rows] of Object.entries(before.rows)) {
    const now = after.rows[table]
    if (!now) { out.push(`${table}: table dropped (${Object.keys(rows).length} row(s))`); continue }
    for (const [key, row] of Object.entries(rows)) {
      const got = now[key]
      if (!got) { out.push(`${table} ${key}: row missing`); continue }
      for (const [col, v] of Object.entries(row)) {
        if (!(col in got)) out.push(`${table} ${key}: column ${col} dropped`)
        else if (!same(got[col], v) && !allowed[table]?.includes(col)) out.push(`${table} ${key}: ${col} changed`)
      }
    }
  }
  return out
}
const check = (name: string, d: string[]) => { if (d.length) fail(name, `${d.length} difference(s): ${d.slice(0, 5).join('; ')}`) }

try {
  const before = step('previous release: create and seed', prev, 'seed')
  console.log(`ok   previous release created ${before.objects.filter(o => o.type === 'table').length} tables, seeded ${count(before)} rows${before.notes.length ? ` (${before.notes.join('; ')})` : ''}`)

  const forward = step('new release: migrate forward and read', next, 'read')
  check('new release: migrate forward', differences(before, forward, EXPECTED_CHANGES))
  const added = forward.objects.length - before.objects.length
  console.log(`ok   new release migrated forward: every previous row kept with every value, ${count(forward) - count(before)} row(s) added, ${added >= 0 ? '+' : ''}${added} schema object(s); ${forward.notes.join('; ')}`)

  const again = step('new release: migrate again', next, 'migrate')
  if (!same(again.objects, forward.objects)) fail('new release: migrate again', 'a second migration changed the schema (not idempotent)')
  check('new release: migrate again', [...differences(forward, again, {}), ...differences(again, forward, {}).map(d => `${d} (added)`)])
  console.log('ok   new release migrated again: schema and every value unchanged')

  const back = step('rollback: previous release on the migrated database', prev, 'read')
  check('rollback: previous release on the migrated database', differences(again, back, {}))
  console.log(`ok   rollback: the previous release migrates the new database without changing a value; ${back.notes.join('; ')}`)

  if (keep) {
    mkdirSync(keep, { recursive: true }); copyFileSync(DB_PATH, path.join(keep, 'app.db'))
    const env = path.join(keep, 'gate.env')
    writeFileSync(env, Object.entries({ ...SYNTH, DB_PATH: path.join(keep, 'app.db') }).map(([k, v]) => `${k}=${v}`).join('\n') + '\n'); chmodSync(env, 0o600)
    console.log(`ok   migrated database and its synthetic env kept in ${keep} for scripts/rollback-start-check.mjs`)
  }
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
console.log('migration-gate: forward, re-run and rollback all hold')
