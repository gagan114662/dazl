// Named leases in the app_leases table: at most one holder per name at a time, as the store sees it.
//
// What a lease guarantees: while the holder's process runs and can renew, a heartbeat keeps the lease however long its
// work takes, so a second instance does not start the same work. keep(), called between steps, stops the holder before
// the next step once renewals have failed and the confirmed expiry is near.
// What it does NOT guarantee: it is not a fence. If the holder's own connection fails while the store stays reachable
// for others, the lease can expire and be taken over while the holder is still inside a step; when its connection
// recovers, that step can still write. Work whose effects must never run twice needs its own fence where the effect
// happens (for sends: the durable per-row claims in the outreach modules). A lease only keeps the normal case from
// doing the work twice.
// Acquire is one atomic upsert that takes the row over only when it is free or expired; renew and release only touch
// the row while this holder still owns it.
import { randomBytes } from 'node:crypto'
import type { Db } from '../db/client.ts'

export class LeaseLost extends Error {
  constructor(name: string, why: string) { super(`lease ${name} lost: ${why}; stopping before the next step`) }
}

export interface Lease {
  readonly name: string
  readonly owner: string
  // Call between steps. Renews when due; throws LeaseLost if the lease could not be confirmed with stepBudgetMs to spare.
  keep(now?: number): Promise<void>
  release(): Promise<void>
}

export interface LeaseOptions { ttlMs: number; stepBudgetMs: number; renewEveryMs?: number; heartbeat?: boolean }

export async function tryLease(db: Db, name: string, o: LeaseOptions, now = Date.now()): Promise<Lease | null> {
  if (o.stepBudgetMs >= o.ttlMs) throw new Error('stepBudgetMs must be shorter than ttlMs')
  const renewEvery = o.renewEveryMs ?? Math.floor((o.ttlMs - o.stepBudgetMs) / 3)
  const owner = randomBytes(12).toString('hex')
  const r = await db.get<{ owner: string }>(
    `INSERT INTO app_leases (name, owner, expires_at) VALUES (?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
       WHERE app_leases.expires_at <= ?
     RETURNING owner`,
    [name, owner, now + o.ttlMs, now])
  if (r?.owner !== owner) return null
  // expiresAt is the expiry this holder last saw confirmed in the store; it never assumes more than that.
  let expiresAt = now + o.ttlMs
  let renewedAt = now
  let lost = false
  const renew = async (at: number) => {
    if (lost) return
    try {
      const u = await db.run('UPDATE app_leases SET expires_at = CASE WHEN expires_at < ? THEN ? ELSE expires_at END WHERE name = ? AND owner = ? AND expires_at > ?', [at + o.ttlMs, at + o.ttlMs, name, owner, at])
      if (u.changes === 1) { expiresAt = Math.max(expiresAt, at + o.ttlMs); renewedAt = at }
      else lost = true // taken over or already expired: never try to win it back
    } catch { /* store unreachable: rely only on the expiry already confirmed */ }
  }
  // Heartbeat on the wall clock (callers that pass `now` for tests drive renewals through keep()). unref: never keeps
  // the process alive on its own.
  const timer = o.heartbeat === false ? null : setInterval(() => { void renew(Date.now()) }, renewEvery)
  timer?.unref()
  return {
    name, owner,
    async keep(at = Date.now()) {
      if (at - renewedAt >= renewEvery) await renew(at)
      if (lost) throw new LeaseLost(name, 'taken over or expired')
      if (expiresAt - at < o.stepBudgetMs) throw new LeaseLost(name, `less than ${o.stepBudgetMs} ms of confirmed lease left`)
    },
    release: async () => {
      if (timer) clearInterval(timer)
      lost = true
      await db.run('DELETE FROM app_leases WHERE name = ? AND owner = ?', [name, owner])
    },
  }
}
