// Named leases in the app_leases table: at most one holder per name across all app instances, until it releases the
// lease or the lease expires (so a crashed holder cannot block the work forever). Acquire is one atomic upsert that
// only takes the row over when it is free or expired.
import { randomBytes } from 'node:crypto'
import type { Db } from '../db/client.ts'

export interface Lease { name: string; owner: string; release(): Promise<void> }

export async function tryLease(db: Db, name: string, ttlMs: number, now = Date.now()): Promise<Lease | null> {
  const owner = randomBytes(12).toString('hex')
  const r = await db.get<{ owner: string }>(
    `INSERT INTO app_leases (name, owner, expires_at) VALUES (?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
       WHERE app_leases.expires_at <= ?
     RETURNING owner`,
    [name, owner, now + ttlMs, now])
  if (r?.owner !== owner) return null
  return {
    name, owner,
    // Only the holder's own row is removed: a lease that expired and was taken over by someone else is left alone.
    release: async () => { await db.run('DELETE FROM app_leases WHERE name = ? AND owner = ?', [name, owner]) },
  }
}
