import type Database from 'better-sqlite3'

// Runs `hook` at the admission fence of POST /api/scan (#913): the moment the handler opens its IMMEDIATE transaction, after the route's early checks
// have passed and before the fence's own recheck. Test-only: wraps db.transaction so the returned transaction's `.immediate` calls the hook first.
export function atFence(db: Database.Database, hook: () => void) {
  const original = db.transaction.bind(db)
  ;(db as unknown as { transaction: unknown }).transaction = (fn: never) => {
    const tx = original(fn) as unknown as Record<string, (...a: unknown[]) => unknown> & ((...a: unknown[]) => unknown)
    const wrapped = ((...a: unknown[]) => tx(...a)) as typeof tx
    wrapped.default = tx.default; wrapped.deferred = tx.deferred; wrapped.exclusive = tx.exclusive
    wrapped.immediate = (...a: unknown[]) => { hook(); return tx.immediate(...a) }
    return wrapped
  }
}
