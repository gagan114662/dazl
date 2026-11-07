// #988 fixture safety checks: backup, restore proof and an unrelated-data comparison, to run around staging-fixture-988.mts. All READ-ONLY against the live database (the backup uses SQLite's online
// backup API into a NEW file; nothing here writes to the staging database). Same environment guards and exact database path as the loader.
//
//   snapshot  --out=<file>                   before: per-table row counts + a hash of every row that is not a fixture row, plus the schema hash
//   backup    --out=<file.db>                before: an online backup into a new file (refuses to overwrite), integrity-checked
//   restore-check --backup=<file.db> --snapshot=<file>   proves the backup, restored into a scratch copy, reproduces the snapshot exactly (restoring the LIVE database is a separate, manual step)
//   after     --snapshot=<file>              after apply: only scan_jobs +1 / leads +4 changed, every unrelated row and the schema are identical
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkDbFile, checkEnvironment, FixtureRefused, fixtureLeads, JOB_ID, type Env } from './staging-fixture-988.mts'

export interface Snapshot { tables: Record<string, { rows: number; fixtureRows: number; hash: string }>; schema: string; tenants: number }
const h = (x: string) => createHash('sha256').update(x).digest('hex')
export function takeSnapshot(raw: Database.Database): Snapshot {
  const ids = new Set(fixtureLeads(0).map(l => l.id))
  const tables: Snapshot['tables'] = {}
  for (const { name } of raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]) {
    let rows: Record<string, unknown>[]
    try { rows = raw.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all() as Record<string, unknown>[] } catch { rows = raw.prepare(`SELECT * FROM "${name}"`).all() as Record<string, unknown>[] }
    const isFixture = (r: Record<string, unknown>) => (name === 'scan_jobs' && r.id === JOB_ID) || (name === 'leads' && ids.has(String(r.id)))
    const unrelated = rows.filter(r => !isFixture(r))
    // insert_seq is a counter the database assigns to every new scan_jobs row; it differs by design after the fixture row is added, so it is excluded from the row hash (the row's own fields are not)
    const stable = (r: Record<string, unknown>) => { const { insert_seq: _s, ...rest } = r; void _s; return rest }
    tables[name] = { rows: rows.length, fixtureRows: rows.length - unrelated.length, hash: h(JSON.stringify(unrelated.map(stable))) }
  }
  const schema = h(JSON.stringify(raw.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()))
  let tenants = -1; try { tenants = (raw.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n } catch { /* no users table: reported through the table comparison */ }
  return { tables, schema, tenants }
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
  }
  return problems
}
export async function backupTo(raw: Database.Database, dest: string): Promise<void> {
  if (existsSync(dest)) throw new FixtureRefused('backup_exists', `${dest} already exists; refusing to overwrite a backup`)
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...rest] = process.argv.slice(2), arg = (k: string) => rest.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3)
  const env: Env = { DAZL_ENV: process.env.DAZL_ENV, DB_PATH: process.env.DB_PATH, DAZL_STAGING_REAL_GMAIL: process.env.DAZL_STAGING_REAL_GMAIL }
  let raw: Database.Database | null = null
  try {
    checkEnvironment(env); checkDbFile(env.DB_PATH!)
    raw = new Database(env.DB_PATH!, { readonly: true, fileMustExist: true })
    const need = (k: string) => arg(k) ?? (() => { throw new FixtureRefused('argument_missing', `--${k}= is required`) })()
    if (cmd === 'snapshot') { const out = need('out'); if (existsSync(out)) throw new FixtureRefused('snapshot_exists', `${out} exists`); writeFileSync(out, JSON.stringify(takeSnapshot(raw), null, 1)); console.log(`snapshot written: ${out}`) }
    else if (cmd === 'backup') { await backupTo(raw, need('out')); console.log(`backup written and integrity-checked: ${need('out')}`) }
    else if (cmd === 'restore-check') { const p = restoreCheck(need('backup'), JSON.parse(readFileSync(need('snapshot'), 'utf8'))); console.log(p.length ? `RESTORE CHECK FAILED:\n${p.join('\n')}` : 'restore check passed: the backup reproduces the snapshot exactly'); process.exitCode = p.length ? 4 : 0 }
    else if (cmd === 'after') { const p = compareAfter(JSON.parse(readFileSync(need('snapshot'), 'utf8')), takeSnapshot(raw)); console.log(p.length ? `UNRELATED-DATA CHECK FAILED:\n${p.join('\n')}` : 'unrelated-data check passed: only scan_jobs +1 and leads +4 changed; schema and every other row identical'); process.exitCode = p.length ? 4 : 0 }
    else throw new FixtureRefused('unknown_command', 'use: snapshot | backup | restore-check | after')
  } catch (e) { console.error(e instanceof Error ? e.message : e); process.exitCode = e instanceof FixtureRefused ? 3 : 1 } finally { raw?.close() }
}
