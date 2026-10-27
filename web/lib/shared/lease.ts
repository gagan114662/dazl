// Named leases in the app_leases table: at most one holder per name across all app instances.
//
// No overlap, even for work that outlives the TTL: the holder renews its lease at checkpoints between steps (keep()),
// and keep() only lets the next step start while the lease it holds has at least `stepBudgetMs` left. Another
// instance can take the lease over only once it has expired, and by then the holder has stopped starting steps. The
// guarantee holds as long as each single step between checkpoints finishes within stepBudgetMs (callers keep steps
// bounded: one tenant's work, with network timeouts well under the budget).
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

export interface LeaseOptions { ttlMs: number; stepBudgetMs: number; renewEveryMs?: number }

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
  return {
    name, owner,
    async keep(at = Date.now()) {
      if (at - renewedAt >= renewEvery) {
        try {
          const u = await db.run('UPDATE app_leases SET expires_at = ? WHERE name = ? AND owner = ? AND expires_at > ?', [at + o.ttlMs, name, owner, at])
          if (u.changes === 1) { expiresAt = at + o.ttlMs; renewedAt = at }
          else throw new LeaseLost(name, 'taken over or expired')
        } catch (e) {
          if (e instanceof LeaseLost) throw e
          // Store unreachable: keep going only on the expiry already confirmed, while it still covers a whole step.
        }
      }
      if (expiresAt - at < o.stepBudgetMs) throw new LeaseLost(name, `less than ${o.stepBudgetMs} ms of confirmed lease left`)
    },
    release: async () => { await db.run('DELETE FROM app_leases WHERE name = ? AND owner = ?', [name, owner]) },
  }
}
