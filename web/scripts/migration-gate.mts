// Release gate for the SQLite schema (issue #362; .github/workflows/release-gate.yml). Production runs SQLite and every
// release migrates its database at startup (lib/db/sqlite-migrations.ts), so a release must be able to:
//   1. forward: open a database the previous release created and filled, without error, losing no row;
//   2. re-run: migrate the same database again and change nothing (every restart does this);
//   3. roll back: the previous release must still start on the database the new release migrated (deploy.sh and
//      DEPLOY.md "Rollback" put the previous release back on the same file).
// Each step runs in its own process with that release's own code. The previous release's database is filled by its own
// staging seed (synthetic: one demo account, two scans, leads, a stub Gmail connection; no real data).
//   node --experimental-strip-types scripts/migration-gate.mts <previous release web dir> [<new release web dir>]
// The new release defaults to this checkout. The previous release's directory needs node_modules (CI links this one's).
// Exit 0 = all three hold; exit 1 names the failed step.
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const [prevArg, nextArg] = process.argv.slice(2)
if (!prevArg) { console.error('usage: migration-gate.mts <previous release web dir> [<new release web dir>]'); process.exit(2) }
const prev = path.resolve(prevArg)
const next = path.resolve(nextArg ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'))
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-migration-gate-'))
const DB_PATH = path.join(tmp, 'app.db')

// One step in a child process: `dir`'s migrations (and optionally its staging seed) on DB_PATH, then a JSON snapshot of
// the database (schema, row counts, integrity) on stdout.
const STEP = `
import Database from 'better-sqlite3'
const [dir, db_path, seed] = process.argv.slice(1)
const { migrateAllSqlite } = await import(dir + '/lib/db/sqlite-migrations.ts')
const raw = new Database(db_path)
migrateAllSqlite(raw)
if (seed === '1') {
  const { seedStaging } = await import(dir + '/scripts/staging-seed.mts')
  await seedStaging(raw, process.env.STAGING_DEMO_PASSWORD)
}
const objects = raw.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()
const counts = {}
for (const t of objects.filter(o => o.type === 'table')) counts[t.name] = raw.prepare('SELECT count(*) AS n FROM "' + t.name.replaceAll('"', '""') + '"').get().n
const integrity = raw.prepare('PRAGMA integrity_check').pluck().all()
const fk = raw.prepare('PRAGMA foreign_key_check').all()
raw.close()
process.stdout.write(JSON.stringify({ objects, counts, integrity, fk }))
`
type Snap = { objects: { type: string; name: string; sql: string | null }[]; counts: Record<string, number>; integrity: string[]; fk: unknown[] }
function step(name: string, dir: string, seed = false): Snap {
  if (!existsSync(path.join(dir, 'lib/db/sqlite-migrations.ts'))) fail(name, `${dir} has no lib/db/sqlite-migrations.ts`)
  if (seed && !existsSync(path.join(dir, 'scripts/staging-seed.mts'))) { console.log(`note ${dir} has no staging seed: its schema is checked empty`); seed = false }
  // The child imports better-sqlite3 from `dir`, so it runs there with that release's node_modules.
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', STEP, dir, DB_PATH, seed ? '1' : '0'], {
    cwd: dir, encoding: 'utf8', timeout: 120_000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, DB_PATH, DAZL_ENV: 'staging', PUBLIC_BASE_URL: 'https://staging.example.test',
      DAZL_MASTER_KEY: randomBytes(32).toString('base64'), STAGING_DEMO_PASSWORD: randomBytes(12).toString('hex') } as unknown as NodeJS.ProcessEnv,
  })
  if (r.status !== 0) fail(name, (r.stderr || r.stdout || String(r.error)).trim().split('\n').slice(-5).join('\n'))
  const snap = JSON.parse(r.stdout) as Snap
  if (snap.integrity.join() !== 'ok') fail(name, `integrity_check: ${snap.integrity.join('; ')}`)
  if (snap.fk.length) fail(name, `foreign_key_check: ${snap.fk.length} violation(s)`)
  return snap
}
function fail(name: string, why: string): never {
  console.error(`migration-gate: FAIL ${name}: ${why}`)
  rmSync(tmp, { recursive: true, force: true }); process.exit(1)
}
const rows = (s: Snap) => Object.values(s.counts).reduce((a, b) => a + b, 0)
const schema = (s: Snap) => JSON.stringify(s.objects)

try {
  const before = step('previous release: create and seed', prev, true)
  console.log(`ok   previous release created ${before.objects.filter(o => o.type === 'table').length} tables, seeded ${rows(before)} rows`)

  const forward = step('new release: migrate forward', next)
  const lost = Object.entries(before.counts).filter(([t, n]) => (forward.counts[t] ?? 0) < n).map(([t, n]) => `${t} ${n} -> ${forward.counts[t] ?? 'dropped'}`)
  if (lost.length) fail('new release: migrate forward', `rows lost: ${lost.join(', ')}`)
  const added = forward.objects.length - before.objects.length
  console.log(`ok   new release migrated forward: no row lost, ${added >= 0 ? '+' : ''}${added} schema object(s), integrity ok`)

  const again = step('new release: migrate again', next)
  if (schema(again) !== schema(forward)) fail('new release: migrate again', 'a second migration changed the schema (not idempotent)')
  if (JSON.stringify(again.counts) !== JSON.stringify(forward.counts)) fail('new release: migrate again', 'a second migration changed row counts')
  console.log('ok   new release migrated again: nothing changed')

  const back = step('rollback: previous release on the migrated database', prev)
  const lostBack = Object.entries(again.counts).filter(([t, n]) => (back.counts[t] ?? 0) < n).map(([t]) => t)
  if (lostBack.length) fail('rollback: previous release on the migrated database', `rows lost: ${lostBack.join(', ')}`)
  console.log('ok   rollback: the previous release starts on the migrated database, no row lost, integrity ok')
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
console.log('migration-gate: forward, re-run and rollback all hold')
