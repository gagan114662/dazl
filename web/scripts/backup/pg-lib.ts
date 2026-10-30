// Postgres backup and recovery drill (issue #360, part 3; docs/RECOVERY.md "Postgres cutover"). The SQLite tooling
// (lib.ts, recovery-drill.mts) stays the production path until the cutover; this is its Postgres counterpart, built and
// rehearsed before the cutover rather than after.
//   createPgBackup   pg_dump -Fc of one database, plus a sidecar: sha256 and size of the dump, and a content
//                    fingerprint (per table: row count and md5 of every row) taken IN THE SAME SNAPSHOT as the dump
//                    (pg_export_snapshot + pg_dump --snapshot), so a write during the backup cannot make them disagree
//   pgRecoveryDrill  verifies the sidecar, pg_restores into a scratch database it creates (random name, never an
//                    existing one), compares the restored content with the fingerprint, decrypts every registered
//                    ciphertext under the RECOVERED master key (counts only), reports what must be reconciled before
//                    sending is re-enabled, times every step, and drops the scratch database
// Credentials reach pg_dump/pg_restore through PG* environment variables, never the command line (no password in ps).
// Not built here: starting the app on the restored database, because the app does not read Postgres yet
// (docs/PLATFORM.md); the report says so instead of passing it.
import pg from 'pg'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { decryptSecret } from '../../lib/secrets.ts'
import { REWRAP_COLUMNS } from '../../lib/secrets-rewrap.ts'

export interface TablePrint { rows: number; md5: string }
export interface PgSidecar {
  kind: 'dazl-pg-backup'; version: 1; createdAt: string; file: string; bytes: number; sha256: string
  format: 'pg_dump custom'; server_version: string; tables: Record<string, TablePrint>
}

// PG* variables for the client tools; the URL's password never goes on a command line
export function pgEnv(url: string, database?: string): NodeJS.ProcessEnv {
  const u = new URL(url)
  return {
    PATH: process.env.PATH, HOME: process.env.HOME,
    PGHOST: u.hostname.replace(/^\[|\]$/g, ''), PGPORT: u.port || '5432', PGUSER: decodeURIComponent(u.username || 'postgres'),
    PGPASSWORD: decodeURIComponent(u.password), PGDATABASE: database ?? decodeURIComponent(u.pathname.slice(1) || 'postgres'),
    PGCONNECT_TIMEOUT: '10',
  } as unknown as NodeJS.ProcessEnv
}
const withDb = (url: string, database: string) => { const u = new URL(url); u.pathname = '/' + database; return u.toString() }
const quoteIdent = (s: string) => '"' + s.replace(/"/g, '""') + '"'

// Every base table in the public schema: its row count and the md5 of its rows' text, ordered, so two databases with the
// same content give the same print whatever their physical order. Whole-table hashing is O(rows): fine for dazl's size;
// a much larger database would hash in chunks.
export async function fingerprint(c: pg.ClientBase): Promise<Record<string, TablePrint>> {
  const out: Record<string, TablePrint> = {}
  const tables = (await c.query<{ t: string }>("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name")).rows
  for (const { t } of tables) {
    const r = (await c.query<{ n: string; h: string }>(`SELECT count(*) AS n, md5(coalesce(string_agg(x.r, E'\\n' ORDER BY x.r), '')) AS h FROM (SELECT t::text AS r FROM public.${quoteIdent(t)} t) x`)).rows[0]
    out[t] = { rows: Number(r.n), md5: r.h }
  }
  return out
}

const run = (cmd: string, args: string[], env: NodeJS.ProcessEnv) => new Promise<{ code: number; err: string }>((resolve, reject) => {
  const p = spawn(cmd, args, { env, stdio: ['ignore', 'ignore', 'pipe'] })
  let err = ''
  p.stderr.on('data', d => { err = (err + d).slice(-2000) })
  p.on('error', reject)
  p.on('exit', code => resolve({ code: code ?? -1, err }))
})
export const sha256File = (file: string) => new Promise<string>((resolve, reject) => {
  const h = createHash('sha256'); createReadStream(file).on('data', d => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')))
})

export async function createPgBackup(o: { url: string; destDir: string; pgDump?: string; now?: Date }): Promise<{ backupPath: string; sidecar: PgSidecar }> {
  mkdirSync(o.destDir, { recursive: true, mode: 0o700 })
  const at = o.now ?? new Date()
  const file = path.join(o.destDir, `dazl-pg-${at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}.dump`)
  if (existsSync(file)) throw new Error(`${file} already exists`)
  const c = new pg.Client({ connectionString: o.url })
  await c.connect()
  try {
    // one snapshot for the dump and the fingerprint
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const snap = (await c.query<{ s: string }>('SELECT pg_export_snapshot() AS s')).rows[0].s
    const server = (await c.query<{ v: string }>('SHOW server_version')).rows[0].v
    const tables = await fingerprint(c)
    writeFileSync(file, '', { mode: 0o600 })
    const d = await run(o.pgDump ?? 'pg_dump', ['--format=custom', '--no-owner', '--no-privileges', `--snapshot=${snap}`, `--file=${file}`], pgEnv(o.url))
    if (d.code !== 0) { rmSync(file, { force: true }); throw new Error(`pg_dump failed (exit ${d.code}): ${d.err.trim().split('\n').at(-1) ?? ''}`) }
    await c.query('COMMIT')
    const sidecar: PgSidecar = { kind: 'dazl-pg-backup', version: 1, createdAt: at.toISOString(), file: path.basename(file), bytes: statSync(file).size, sha256: await sha256File(file), format: 'pg_dump custom', server_version: server, tables }
    writeFileSync(file + '.json', JSON.stringify(sidecar, null, 2) + '\n', { mode: 0o600 })
    return { backupPath: file, sidecar }
  } finally { await c.end() }
}

export type Step = { step: string; ok: boolean; ms: number; detail: Record<string, unknown> }
export interface PgDrillReport {
  kind: 'dazl pg recovery drill'; version: 1; started_at: string; backup: string; backup_created_at: string | null
  rpo_at_drill_s: number | null; measured_rto_ms: number; ok: boolean; steps: Step[]; scratch_database: string | null; app: string
}

export async function pgRecoveryDrill(o: { backup: string; master: Buffer; adminUrl: string; pgRestore?: string; keep?: boolean; now?: () => number }): Promise<PgDrillReport> {
  const now = o.now ?? Date.now
  const t0 = now(), steps: Step[] = []
  const step = async (name: string, f: () => Promise<{ ok: boolean; detail: Record<string, unknown> }>) => {
    const s = now()
    try { const r = await f(); steps.push({ step: name, ok: r.ok, ms: now() - s, detail: r.detail }); return r.ok }
    catch (e) { steps.push({ step: name, ok: false, ms: now() - s, detail: { error: e instanceof Error ? e.message : String(e) } }); return false }
  }
  let side: PgSidecar | null = null
  try { side = JSON.parse(readFileSync(o.backup + '.json', 'utf8')) } catch { /* reported by the content step */ }
  const scratch = 'dazl_drill_' + randomBytes(6).toString('hex')
  const admin = new pg.Client({ connectionString: o.adminUrl })
  await admin.connect()
  let created = false
  let restored: pg.Client | null = null
  try {
    const contentOk = await step('content', async () => {
      if (!side || side.kind !== 'dazl-pg-backup') return { ok: false, detail: { reason: 'no dazl-pg-backup sidecar next to the dump: its content cannot be verified' } }
      const before = await sha256File(o.backup)
      if (before !== side.sha256 || statSync(o.backup).size !== side.bytes) return { ok: false, detail: { reason: 'the dump does not match its sidecar (sha256 or size): modified or truncated after it was taken' } }
      if ((await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [scratch])).rowCount) throw new Error(`${scratch} already exists`)
      await admin.query(`CREATE DATABASE ${quoteIdent(scratch)}`); created = true
      const r = await run(o.pgRestore ?? 'pg_restore', ['--no-owner', '--no-privileges', '--exit-on-error', `--dbname=${scratch}`, o.backup], pgEnv(o.adminUrl, scratch))
      if (r.code !== 0) return { ok: false, detail: { reason: `pg_restore failed (exit ${r.code})`, error: r.err.trim().split('\n').at(-1) ?? '' } }
      restored = new pg.Client({ connectionString: withDb(o.adminUrl, scratch) }); await restored.connect()
      const got = await fingerprint(restored)
      const names = [...new Set([...Object.keys(side.tables), ...Object.keys(got)])].sort()
      const missing = names.filter(t => !got[t]), extra = names.filter(t => !side!.tables[t])
      const differ = names.filter(t => got[t] && side!.tables[t] && (got[t].rows !== side!.tables[t].rows || got[t].md5 !== side!.tables[t].md5))
      const after = await sha256File(o.backup)
      return {
        ok: !missing.length && !extra.length && !differ.length && after === before,
        detail: { tables: names.length, rows: Object.values(got).reduce((a, t) => a + t.rows, 0), missing, extra, differ, backup_unchanged: after === before, server_version_at_backup: side.server_version },
      }
    })
    if (contentOk && restored) {
      const db: pg.Client = restored
      await step('key recovery', async () => {
        const columns: Record<string, { total: number; decrypted: number; failed: number }> = {}
        for (const spec of REWRAP_COLUMNS) {
          const c = columns[`${spec.table}.${spec.column}`] = { total: 0, decrypted: 0, failed: 0 }
          if (!(await db.query('SELECT to_regclass($1) AS r', [`public.${spec.table}`])).rows[0].r) continue
          const rows = (await db.query(`SELECT ${spec.pk.map(quoteIdent).join(', ')}, ${quoteIdent(spec.column)} AS blob FROM public.${quoteIdent(spec.table)} WHERE ${quoteIdent(spec.column)} IS NOT NULL`)).rows as Record<string, string>[]
          for (const row of rows) { c.total++; try { decryptSecret(row.blob, spec.ctx(row), o.master); c.decrypted++ } catch { c.failed++ } } // plaintext discarded
        }
        const total = Object.values(columns).reduce((a, c) => a + c.total, 0), failed = Object.values(columns).reduce((a, c) => a + c.failed, 0)
        return { ok: failed === 0 && total > 0, detail: { columns, total, failed, ...(total === 0 ? { note: 'no encrypted rows: the key is not proven by this backup' } : {}) } }
      })
      await step('send safety (reconcile before enabling sending)', async () => {
        const has = async (t: string) => !!(await db.query('SELECT to_regclass($1) AS r', [`public.${t}`])).rows[0].r
        const n = async (t: string, sql: string, p: unknown[] = []) => await has(t) ? Number((await db.query<{ n: string }>(sql, p)).rows[0].n) : 0
        const at = Math.floor(now() / 1000)
        // a report, not a failure: these are reconciled (resolveUncertain, lease expiry) before sending is re-enabled
        return { ok: true, detail: {
          messages_sending: await n('outreach_messages', "SELECT count(*) AS n FROM outreach_messages WHERE status = 'sending'"),
          messages_uncertain: await n('outreach_messages', "SELECT count(*) AS n FROM outreach_messages WHERE status = 'uncertain'"),
          sequence_steps_unresolved: await n('sequence_steps', "SELECT count(*) AS n FROM sequence_steps WHERE status IN ('sending','uncertain')"),
          followups_unresolved: await n('followup_messages', "SELECT count(*) AS n FROM followup_messages WHERE status IN ('sending','uncertain')"),
          leases_unexpired_at_drill: await n('app_leases', 'SELECT count(*) AS n FROM app_leases WHERE expires_at > $1', [at]),
          tenants_autopilot_on: await n('autopilot_settings', 'SELECT count(*) AS n FROM autopilot_settings WHERE enabled = 1 AND paused = 0'),
        } }
      })
    }
  } finally {
    if (restored) await (restored as pg.Client).end()
    if (created && !o.keep) await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(scratch)} WITH (FORCE)`)
    await admin.end()
  }
  return {
    kind: 'dazl pg recovery drill', version: 1, started_at: new Date(t0).toISOString(), backup: path.basename(o.backup),
    backup_created_at: side?.createdAt ?? null, rpo_at_drill_s: side?.createdAt ? Math.round((t0 - Date.parse(side.createdAt)) / 1000) : null,
    measured_rto_ms: now() - t0, ok: steps.length === 3 && steps.every(s => s.ok), steps,
    scratch_database: created && o.keep ? scratch : null,
    app: 'not checked: the app does not read Postgres yet (docs/PLATFORM.md); add the app-readability step before the cutover',
  }
}
