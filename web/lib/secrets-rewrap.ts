// Master-key rotation driver: re-wraps every registered ciphertext column from
// the old master key to the new one using rewrapSecret (envelope rewrap - secret
// bodies and plaintexts are never touched). The column registry is a FIXED
// allowlist: an unknown table/column is never rewrapped, so a new ciphertext
// column added to the schema later cannot be silently half-migrated - the tool
// must be extended deliberately.
//
// Failure semantics: each row is rewrapped in its own transaction with a
// compare-and-swap on the original blob, so a crash or a concurrent writer
// leaves a consistent, resumable state - re-running is safe (already-rewrapped
// rows are skipped). Any row that cannot be unwrapped with the old key, has an
// unknown format, or was concurrently modified ABORTS the run (fail closed).
// Logs and errors carry counts and row locators only - never blob or key
// material.
import type Database from 'better-sqlite3'
import { rewrapSecret } from './secrets.ts'

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

// Throws (fail closed) with a locator-only message on the first row that cannot
// be rewrapped; committed earlier rows stay rewrapped and a re-run resumes them.
// opts.quarantineCorrupt: instead of aborting, count and skip rows that can be
// rewrapped under NEITHER key (parse failure, unknown version, both unwraps fail)
// so a rollback can still recover every other row. Rows that unwrap under the old
// key but whose write fails (concurrent modification) ALWAYS abort - that is a
// fencing problem, never corruption.
export function rewrapMasterKey(db: Database.Database, oldMaster: Buffer, newMaster: Buffer, opts: { dryRun?: boolean; quarantineCorrupt?: boolean } = {}): RewrapColumnResult[] {
  if (oldMaster.equals(newMaster)) throw new Error('old and new master keys are identical')
  const results: RewrapColumnResult[] = []
  for (const spec of REWRAP_COLUMNS) {
    const exists = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(spec.table)
    if (!exists) { results.push({ table: spec.table, column: spec.column, missing: true, rewrapped: 0, skipped: 0, corrupt: 0 }); continue }
    const rows = db.prepare(`SELECT ${spec.pk.map(c => `"${c}"`).join(', ')}, "${spec.column}" AS blob FROM "${spec.table}"`).all() as Record<string, string>[]
    let rewrapped = 0, skipped = 0, corrupt = 0
    for (const row of rows) {
      const locator = `${spec.table}(${spec.pk.map(c => `${c}=...`).join(',')})` // pk values are tenant ids - locators only, still no blob
      let out: string, changed: boolean
      try {
        ;({ out, changed } = rewrapSecret(row.blob, spec.ctx(row), oldMaster, newMaster))
      } catch (e) {
        if (opts.quarantineCorrupt) { corrupt++; continue } // reported in the result; row left untouched
        throw e // fail closed
      }
      if (!changed) { skipped++; continue }
      rewrapped++
      if (opts.dryRun) continue
      const where = spec.pk.map(c => `"${c}" = ?`).join(' AND ')
      const txn = db.transaction(() => {
        // Compare-and-swap on the original blob: a concurrent writer changing the
        // row between read and write makes this affect 0 rows -> fail closed.
        const ch = db.prepare(`UPDATE "${spec.table}" SET "${spec.column}" = ? WHERE ${where} AND "${spec.column}" = ?`).run(out, ...spec.pk.map(c => row[c]), row.blob)
        if (ch.changes !== 1) throw new Error(`concurrent modification detected at ${locator} - aborting; re-run after writers are fenced`)
      })
      txn()
    }
    results.push({ table: spec.table, column: spec.column, missing: false, rewrapped, skipped, corrupt })
  }
  return results
}
