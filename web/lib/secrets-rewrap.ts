// Master-key rotation driver: re-wraps every registered ciphertext column from
// the old master key to the new one using rewrapSecret (envelope rewrap - secret
// bodies and plaintexts are never touched). The column registry is a FIXED
// allowlist: an unknown table/column is never rewrapped, so a new ciphertext
// column added to the schema later cannot be silently half-migrated - the tool
// must be extended deliberately.
//
// Design: PREFLIGHT BEFORE WRITE. Phase 1 reads and validates EVERY row and
// computes its rewrapped form in memory; in the default mode a single
// unrewrappable row aborts the run BEFORE any write, so a corrupt row can never
// create a partial migration that later blocks rollback. Phase 2 writes the
// pre-computed rows in per-row transactions with a compare-and-swapon the
// preflight blob. Partial state is therefore possible ONLY from a crash or a
// fence violation mid-write; both directions are idempotent so a re-run resumes
// and a key-swapped run rolls back.
//
// Honesty boundaries: the CAS is defense-in-depth against a writer that slips
// the fence between preflight and write. It is NOT a proven multi-connection
// concurrency fence (no live-second-writer test exists) - the procedure REQUIRES
// a verified single-writer maintenance window. opts.quarantineCorrupt is a
// recovery mode only: rows unrewrappable under NEITHER key are counted and
// skipped so other rows can migrate or roll back, but a quarantined row means an
// UNKNOWN-AFFECTED TENANT whose credential may be unreadable - the count is
// reported precisely and never claimed as healthy.
// Logs and errors carry counts and row locators only - never blob or key
// material.
import type Database from 'better-sqlite3'
import { rewrapSecret, verifyWrap } from './secrets.ts'

interface ColumnSpec {
  table: string
  column: string
  pk: string[]
  ctx: (row: Record<string, string>) => string
}

export const REWRAP_COLUMNS: readonly ColumnSpec[] = [
  { table: 'tenant_llm_keys', column: 'ciphertext', pk: ['tenant_id', 'vendor'], ctx: r => `llm-key:${r.tenant_id}:${r.vendor}` },
  { table: 'tenant_connectors', column: 'ciphertext', pk: ['tenant_id', 'connector'], ctx: r => `connector:${r.tenant_id}:${r.connector}` },
  { table: 'gmail_accounts', column: 'refresh_ct', pk: ['tenant_id'], ctx: r => `gmail-refresh:${r.tenant_id}` },
]

export interface RewrapColumnResult { table: string; column: string; missing: boolean; rewrapped: number; skipped: number; corrupt: number }

interface PlannedRow { spec: ColumnSpec; pks: string[]; original: string; out: string }

const tableExists = (db: Database.Database, table: string) =>
  !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)

const locatorOf = (spec: ColumnSpec) => `${spec.table}(${spec.pk.map(c => `${c}=...`).join(',')})` // pk values are tenant ids - shape only, never values or blobs

export function rewrapMasterKey(db: Database.Database, oldMaster: Buffer, newMaster: Buffer, opts: { dryRun?: boolean; quarantineCorrupt?: boolean } = {}): RewrapColumnResult[] {
  if (oldMaster.equals(newMaster)) throw new Error('old and new master keys are identical')
  const results: RewrapColumnResult[] = []
  const planned: PlannedRow[] = []
  const failedLocators: string[] = []
  // Phase 1 - preflight: read-only validation of every row, outputs in memory.
  for (const spec of REWRAP_COLUMNS) {
    if (!tableExists(db, spec.table)) { results.push({ table: spec.table, column: spec.column, missing: true, rewrapped: 0, skipped: 0, corrupt: 0 }); continue }
    const rows = db.prepare(`SELECT ${spec.pk.map(c => `"${c}"`).join(', ')}, "${spec.column}" AS blob FROM "${spec.table}"`).all() as Record<string, string>[]
    let rewrapped = 0, skipped = 0, corrupt = 0
    for (const row of rows) {
      let out: string, changed: boolean
      try {
        ;({ out, changed } = rewrapSecret(row.blob, spec.ctx(row), oldMaster, newMaster))
      } catch {
        if (opts.quarantineCorrupt) { corrupt++; continue } // recovery mode: counted, left untouched, reported as unknown-affected
        failedLocators.push(locatorOf(spec)); continue
      }
      if (!changed) { skipped++; continue }
      planned.push({ spec, pks: spec.pk.map(c => row[c]), original: row.blob, out })
      rewrapped++
    }
    results.push({ table: spec.table, column: spec.column, missing: false, rewrapped, skipped, corrupt })
  }
  if (failedLocators.length) {
    const shown = failedLocators.slice(0, 5).join(', ')
    throw new Error(`preflight failed: ${failedLocators.length} row(s) cannot be rewrapped under the old key - NO rows were written. Fix the rows or re-run with quarantine (recovery mode). Locators: ${shown}${failedLocators.length > 5 ? ', ...' : ''}`)
  }
  if (opts.dryRun) return results
  // Phase 2 - write: per-row transaction, compare-and-swap on the preflight blob.
  for (const p of planned) {
    const where = p.spec.pk.map(c => `"${c}" = ?`).join(' AND ')
    const txn = db.transaction(() => {
      const ch = db.prepare(`UPDATE "${p.spec.table}" SET "${p.spec.column}" = ? WHERE ${where} AND "${p.spec.column}" = ?`).run(p.out, ...p.pks, p.original)
      if (ch.changes !== 1) throw new Error(`row changed since preflight at ${locatorOf(p.spec)} - aborting; re-run after writers are fenced (committed rows stay valid; re-run resumes)`)
    })
    txn()
  }
  return results
}

export interface VerifyColumnResult { table: string; column: string; missing: boolean; total: number; ok: number; bad: number }

// Read-only WRAP audit: which rows' wrapped data keys open under the given
// master key, via verifyWrap - the secret body is NEVER decrypted and no
// plaintext is materialized anywhere in the verification path. Never throws on
// bad rows - it counts them. This is the explicit post-run gate: after a
// forward run, verifyMasterKey(db, NEW) must show bad = 0 across every column
// before the env swap. bad > 0 means unknown-affected tenants, reported, not
// claimed healthy.
// Guarantee boundary (deliberate, for reviewer judgment): this proves WRAP
// VERIFIED + BODY UNTOUCHED (byte-identity from rewrapSecret), not full secret
// decryptability - a row whose body was already corrupt before rotation but
// whose wrap is intact would pass. Rotation neither causes nor repairs that.
export function verifyMasterKey(db: Database.Database, master: Buffer): VerifyColumnResult[] {
  const results: VerifyColumnResult[] = []
  for (const spec of REWRAP_COLUMNS) {
    if (!tableExists(db, spec.table)) { results.push({ table: spec.table, column: spec.column, missing: true, total: 0, ok: 0, bad: 0 }); continue }
    const rows = db.prepare(`SELECT ${spec.pk.map(c => `"${c}"`).join(', ')}, "${spec.column}" AS blob FROM "${spec.table}"`).all() as Record<string, string>[]
    let ok = 0, bad = 0
    for (const row of rows) {
      try { verifyWrap(row.blob, spec.ctx(row), master); ok++ } catch { bad++ }
    }
    results.push({ table: spec.table, column: spec.column, missing: false, total: rows.length, ok, bad })
  }
  return results
}
