// The off-database tombstone ledger (#359; docs/TENANT-LIFECYCLE.md "Restored backups"). A restore brings back the rows
// of a tenant deleted after the backup was taken and loses its tombstone; this file is what re-applies the deletion
// (reapplyTombstones, scripts/tenant-lifecycle.mts --reapply). One line per deletion (tombstoneLedgerEntry: tenant id,
// time, who, policy; no tenant data), appended and fsynced.
//
// DAZL_TOMBSTONE_LEDGER names the file. It must live outside the database and its backups (a restore must not roll it
// back) and be copied off-host with them. Unset = deletion is refused before anything is written: a deletion that a
// restore could silently undo is not offered. The request flow writes the line right after the tombstone commits and
// before any data step runs, so no data is erased for a deletion the ledger does not hold. The path is runtime
// configuration, so the fs calls opt out of build-time file tracing (turbopackIgnore), or the whole project is traced.
import { closeSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs'
import { tombstoneLedgerEntry, type Tombstone } from './lifecycle.ts'

export const ledgerPath = (): string | null => process.env.DAZL_TOMBSTONE_LEDGER?.trim() || null

// Idempotent: a resumed deletion whose line is already there appends nothing. Throws when the ledger is not configured
// or cannot be written; the caller must not advance the deletion past 'requested' then.
export function ensureLedgered(t: Tombstone): void {
  const file = ledgerPath()
  if (!file) throw new Error('DAZL_TOMBSTONE_LEDGER is not set: the deletion cannot be ledgered off the database')
  let text = ''
  try { text = readFileSync(/*turbopackIgnore: true*/ file, 'utf8') } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
  if (text.split('\n').some(l => { try { return (JSON.parse(l) as { deleted_tenant?: unknown }).deleted_tenant === t.deleted_tenant } catch { return false } })) return
  // a torn last line (a crash mid-append) must not swallow this one
  const line = `${text && !text.endsWith('\n') ? '\n' : ''}${tombstoneLedgerEntry(t)}\n`
  const fd = openSync(/*turbopackIgnore: true*/ file, 'a', 0o600)
  try { writeSync(fd, line); fsyncSync(fd) } finally { closeSync(fd) }
}
