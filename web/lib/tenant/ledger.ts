// The tombstone ledger and backups (issue #359, part 3; docs/TENANT-LIFECYCLE.md "Backups"). A deletion is recorded in
// the database (tenant_tombstones), but a backup taken before it holds the tenant's rows and no tombstone, so the
// record must live OFF the database, next to the backups, and outlive every backup that still holds the tenant:
//   appendLedger      one JSON line per completed deletion (tombstoneLedgerEntry: tenant id, time, who, policy; no
//                     data), appended once per tenant, fsynced, mode 600
//   ledgerFromStore   the lines for every completed deletion in a live store (to rebuild or check the ledger file)
//   planReapply       for a restored store: which ledgered deletions it is missing (rows back, tombstone absent)
//   backupExposure    which backups still hold erased tenants (taken before the deletion) and whether each is past
//                     the owner's backup expiry (decision 6); a report only, nothing is deleted
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync, chmodSync } from 'node:fs'
import { asDb, type DbLike } from '../db/client.ts'
import { tombstoneLedgerEntry, type Tombstone } from './lifecycle.ts'

export interface LedgerEntry { kind: 'dazl-tenant-tombstone'; deleted_tenant: string; requested_at: number; requested_by: string; policy: unknown }

export function parseLedger(text: string): LedgerEntry[] {
  const out: LedgerEntry[] = []
  for (const [n, raw] of text.split('\n').entries()) {
    const line = raw.trim()
    if (!line) continue
    let e: LedgerEntry
    try { e = JSON.parse(line) } catch { throw new Error(`ledger line ${n + 1} is not JSON`) }
    if (e?.kind !== 'dazl-tenant-tombstone' || typeof e.deleted_tenant !== 'string' || !Number.isFinite(Number(e.requested_at))) throw new Error(`ledger line ${n + 1} is not a tenant tombstone`)
    out.push(e)
  }
  return out
}
export const readLedger = (file: string): LedgerEntry[] => existsSync(file) ? parseLedger(readFileSync(file, 'utf8')) : []

// Append a completed deletion. Once per tenant: a second append for the same tenant (a retried operator step) is a
// no-op. Only a completed tombstone is ledgered; an unfinished one would be re-applied with no proof it was meant.
export function appendLedger(file: string, t: Tombstone): 'appended' | 'already_ledgered' {
  if (t.state !== 'completed') throw new Error(`tombstone for ${t.deleted_tenant} is ${t.state}, not completed: not ledgered`)
  if (readLedger(file).some(e => e.deleted_tenant === t.deleted_tenant)) return 'already_ledgered'
  const fd = openSync(file, 'a', 0o600)
  try { writeSync(fd, tombstoneLedgerEntry(t) + '\n'); fsyncSync(fd) } finally { closeSync(fd) }
  chmodSync(file, 0o600)
  return 'appended'
}

const COMPLETED_SQL = "SELECT * FROM tenant_tombstones WHERE state = 'completed' ORDER BY requested_at, deleted_tenant"
export async function ledgerFromStore(d: DbLike): Promise<string[]> {
  return (await asDb(d).all<Tombstone>(COMPLETED_SQL)).map(tombstoneLedgerEntry)
}

// A restored store: every ledgered deletion it has no completed tombstone for must be re-applied before it serves.
export async function planReapply(d: DbLike, ledger: LedgerEntry[]): Promise<{ missing: LedgerEntry[]; already: string[] }> {
  const done = new Set((await asDb(d).all<{ deleted_tenant: string }>(COMPLETED_SQL)).map(r => r.deleted_tenant))
  return { missing: ledger.filter(e => !done.has(e.deleted_tenant)), already: ledger.filter(e => done.has(e.deleted_tenant)).map(e => e.deleted_tenant) }
}

export interface BackupInfo { name: string; created_at: number }   // unix seconds, from the create-backup sidecar
export interface Exposure {
  backup: string; created_at: number
  erased_tenants: string[]          // deleted after this backup was taken: their data may still be in it
  expires_at: number | null         // created_at + the owner's expiry, or null when no expiry has been decided
  overdue: boolean                  // past expiry and still holding erased tenants' data
}
export function backupExposure(ledger: LedgerEntry[], backups: BackupInfo[], o: { now: number; expireDays: number | null }): { exposures: Exposure[]; overdue: number; policy: string } {
  const exposures = backups.map(b => {
    const erased = ledger.filter(e => Number(e.requested_at) > b.created_at).map(e => e.deleted_tenant)
    const expires = o.expireDays === null ? null : b.created_at + o.expireDays * 86400
    return { backup: b.name, created_at: b.created_at, erased_tenants: erased, expires_at: expires, overdue: erased.length > 0 && expires !== null && o.now > expires }
  }).sort((a, b) => a.created_at - b.created_at || a.backup.localeCompare(b.backup))
  return {
    exposures, overdue: exposures.filter(e => e.overdue).length,
    policy: o.expireDays === null ? 'no backup expiry decided (docs/TENANT-LIFECYCLE.md decision 6): exposure is reported, nothing is judged overdue' : `backups expire ${o.expireDays} days after they were taken`,
  }
}
