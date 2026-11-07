// #988 fixture safety checks: backup, restore proof and an unrelated-data comparison, to run around staging-fixture-988.mts. All READ-ONLY against the live database (the backup uses SQLite's online
// backup API into a NEW file; nothing here writes to the staging database). Same environment guards and exact database path as the loader.
//
//   prepare   --dir=<new dir>                one serialized pre-change state: file hash, snapshot, backup, restore proof, file hash again (all in a new private directory)
//   snapshot  --out=<file>                   before: per-table row counts + a hash of every row that is not a fixture row, plus the schema hash
//   backup    --out=<file.db>                before: an online backup into a new file (refuses to overwrite), integrity-checked
//   restore-check --backup=<file.db> --snapshot=<file>   proves the backup, restored into a scratch copy, reproduces the snapshot exactly (restoring the LIVE database is a separate, manual step)
//   after     --snapshot=<file>              after apply: only scan_jobs +1 / leads +4 changed, every unrelated row and the schema are identical
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkBinding, type Binding } from './staging-fixture-988.mts'
import { checkDbFile, checkEnvironment, FixtureRefused, fixtureLeads, JOB_ID, type Env } from './staging-fixture-988.mts'

export interface Snapshot { tables: Record<string, { rows: number; fixtureRows: number; hash: string; maxSeq: number | null; fixtureSeq: number[] }>; schema: string; tenants: number }
const h = (x: string) => createHash('sha256').update(x).digest('hex')
// ONE database state: every read below happens inside a single read transaction. Every column of every unrelated row is hashed (insert_seq included: adding a row never changes another row's
// insert_seq, because the trigger assigns max+1 to the NEW row only), and the schema hash covers every object including sqlite_* ones (autoindexes, sqlite_sequence). The only legitimate counter
// movement is modelled separately in compareAfter: the fixture rows' own insert_seq values must continue the old maximum without a gap.
export function takeSnapshot(raw: Database.Database): Snapshot {
  const ids = new Set(fixtureLeads(0).map(l => l.id))
  return raw.transaction((): Snapshot => {
    const tables: Snapshot['tables'] = {}
    const names = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map(x => x.name)
    for (const name of names) {
      let rows: Record<string, unknown>[]
      try { rows = raw.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all() as Record<string, unknown>[] } catch { rows = raw.prepare(`SELECT * FROM "${name}"`).all() as Record<string, unknown>[] }
      const isFixture = (r: Record<string, unknown>) => (name === 'scan_jobs' && r.id === JOB_ID) || (name === 'leads' && ids.has(String(r.id)))
      const unrelated = rows.filter(r => !isFixture(r)), mine = rows.filter(isFixture)
      const seqs = unrelated.map(r => r.insert_seq).filter((v): v is number => typeof v === 'number')
      tables[name] = { rows: rows.length, fixtureRows: mine.length, hash: h(JSON.stringify(unrelated)), maxSeq: seqs.length ? Math.max(...seqs) : null, fixtureSeq: mine.map(r => r.insert_seq).filter((v): v is number => typeof v === 'number').sort((x, y) => x - y) }
    }
    const schema = h(JSON.stringify(raw.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all()))
    let tenants = -1; try { tenants = (raw.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n } catch { /* no users table: reported through the table comparison */ }
    return { tables, schema, tenants }
  }).deferred()
}
export function compareAfter(before: Snapshot, after: Snapshot, expected = { scan_jobs: 1, leads: 4 }): string[] {
  const problems: string[] = []
  if (before.schema !== after.schema) problems.push('schema changed')
  if (before.tenants !== after.tenants) problems.push('number of users changed')
  for (const t of new Set([...Object.keys(before.tables), ...Object.keys(after.tables)])) {
    const b = before.tables[t], a = after.tables[t]
    if (!b || !a) { problems.push(`table ${t} ${b ? 'disappeared' : 'appeared'}`); continue }
    if (a.hash !== b.hash) problems.push(`${t}: unrelated rows changed`)
    const grew = a.rows - b.rows, want = t === 'scan_jobs' ? expected.scan_jobs : t === 'leads' ? expected.leads : 0
    if (grew !== want) problems.push(`${t}: ${grew} row(s) added, expected ${want}`)
    // the one legitimate counter movement: the new rows' insert_seq continue the old maximum, consecutively
    if (want > 0 && b.fixtureRows === 0) {
      const base = b.maxSeq ?? 0, exp = Array.from({ length: want }, (_, i) => base + 1 + i)
      if (JSON.stringify(a.fixtureSeq) !== JSON.stringify(exp)) problems.push(`${t}: new rows' insert_seq ${JSON.stringify(a.fixtureSeq)}, expected ${JSON.stringify(exp)}`)
    }
  }
  return problems
}
export async function backupTo(raw: Database.Database, dest: string): Promise<void> {
  // created exclusively and private (0600) BEFORE any data is written: an existing file of any kind refuses, nothing is overwritten
  try { closeSync(openSync(dest, 'wx', 0o600)) } catch { throw new FixtureRefused('backup_exists', `${dest} already exists (or cannot be created); refusing to overwrite a backup`) }
  await raw.backup(dest)
  const b = new Database(dest, { readonly: true, fileMustExist: true })
  try { const ok = b.pragma('integrity_check', { simple: true }); if (ok !== 'ok') throw new FixtureRefused('backup_corrupt', `integrity_check: ${String(ok)}`) } finally { b.close() }
}
// Restore PROOF: the backup file is copied to a scratch file and read back; its snapshot must equal the one taken from the live database before the change. The live database is not touched.
export function restoreCheck(backupPath: string, before: Snapshot): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'fx988-restore-')), copy = join(dir, 'restored.db')
  try {
    copyFileSync(backupPath, copy)
    const r = new Database(copy, { readonly: true, fileMustExist: true })
    try {
      const ok = r.pragma('integrity_check', { simple: true }); if (ok !== 'ok') return [`integrity_check: ${String(ok)}`]
      return compareAfter(before, takeSnapshot(r), { scan_jobs: 0, leads: 0 }).map(p => `restore differs: ${p}`)
    } finally { r.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

const fileHash = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex')
// prepare: ONE serialized pre-change state. The database file is hashed, the snapshot is taken (one read transaction), the backup is made, and the file is hashed again: the two hashes must be equal
// (nothing wrote in between; the host wrapper also holds the writer lock), the backup must restore to that snapshot, and both artifacts are new, private files in a new private directory.
export async function prepare(raw: Database.Database, dbPath: string, dir: string): Promise<{ snapshot: string; backup: string; sha256: string }> {
  if (existsSync(dir)) throw new FixtureRefused('dir_exists', `${dir} already exists`)
  mkdirSync(dir, { mode: 0o700 })
  const h1 = fileHash(dbPath), snap = takeSnapshot(raw), bak = join(dir, 'backup.db')
  await backupTo(raw, bak)
  const h2 = fileHash(dbPath)
  if (h1 !== h2) throw new FixtureRefused('database_changed', 'the database file changed while the snapshot and backup were taken; nothing was proven')
  const problems = restoreCheck(bak, snap)
  if (problems.length) throw new FixtureRefused('backup_does_not_restore', problems.join('; '))
  const sp = join(dir, 'snapshot.json'); writeFileSync(sp, JSON.stringify({ snapshot: snap, sha256: h1 }, null, 1), { flag: 'wx', mode: 0o600 })
  return { snapshot: sp, backup: bak, sha256: h1 }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...rest] = process.argv.slice(2), arg = (k: string) => rest.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3)
  const env: Env = { DAZL_ENV: process.env.DAZL_ENV, DB_PATH: process.env.DB_PATH, DAZL_STAGING_REAL_GMAIL: process.env.DAZL_STAGING_REAL_GMAIL }
  let raw: Database.Database | null = null
  try {
    checkEnvironment(env); checkDbFile(env.DB_PATH!)
    raw = new Database(env.DB_PATH!, { readonly: true, fileMustExist: true })
    const binding: Binding = { expect: process.env.DAZL_FIXTURE_DB_IDENTITY ?? '', production: process.env.DAZL_FIXTURE_PROD_DB_IDENTITY ?? null }
    checkBinding(raw, binding)   // every command, read-only ones included, runs only against the bound staging file
    const need = (k: string) => arg(k) ?? (() => { throw new FixtureRefused('argument_missing', `--${k}= is required`) })()
    if (cmd === 'snapshot') { const out = need('out'); if (existsSync(out)) throw new FixtureRefused('snapshot_exists', `${out} exists`); writeFileSync(out, JSON.stringify({ snapshot: takeSnapshot(raw) }, null, 1), { flag: 'wx', mode: 0o600 }); console.log(`snapshot written: ${out}`) }
    else if (cmd === 'prepare') { const r = await prepare(raw, env.DB_PATH!, need('dir')); console.log(JSON.stringify(r, null, 1)) }
    else if (cmd === 'backup') { await backupTo(raw, need('out')); console.log(`backup written and integrity-checked: ${need('out')}`) }
    else if (cmd === 'restore-check') { const p = restoreCheck(need('backup'), (JSON.parse(readFileSync(need('snapshot'), 'utf8')) as { snapshot: Snapshot }).snapshot); console.log(p.length ? `RESTORE CHECK FAILED:\n${p.join('\n')}` : 'restore check passed: the backup reproduces the snapshot exactly'); process.exitCode = p.length ? 4 : 0 }
    else if (cmd === 'after') { const p = compareAfter((JSON.parse(readFileSync(need('snapshot'), 'utf8')) as { snapshot: Snapshot }).snapshot, takeSnapshot(raw)); console.log(p.length ? `UNRELATED-DATA CHECK FAILED:\n${p.join('\n')}` : 'unrelated-data check passed: only scan_jobs +1 and leads +4 changed; schema and every other row identical'); process.exitCode = p.length ? 4 : 0 }
    else throw new FixtureRefused('unknown_command', 'use: snapshot | backup | restore-check | after')
  } catch (e) { console.error(e instanceof Error ? e.message : e); process.exitCode = e instanceof FixtureRefused ? 3 : 1 } finally { raw?.close() }
}
