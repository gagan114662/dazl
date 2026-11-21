// #1463 (prod 761e4cd, ~20:23Z, 3 min after a deploy): /app sat on "Opening your workspace…" for 15+ s. The store is opened
// lazily, and opening it runs every SQLite migration synchronously (lib/db/client.ts getDb -> migrateAllSqlite). proxy.ts is
// bundled apart from the pages, so it has its OWN getDb: the deploy's health probes warmed the pages' copy, but the proxy's
// copy was first opened by the first signed-in /app request, which then blocked the event loop for the whole migration
// pass (no timer, including the session-check deadline, can fire during sync work). The proxy now opens its store on the
// first request it sees, which during a deploy is the health probe, before any user traffic is switched over.
import type { Db } from './db/client.ts'

let warming: Promise<unknown> | null = null
export function warmStore(getDb: () => Promise<Db>): Promise<unknown> {
  warming ??= getDb().catch(e => { warming = null; throw e })
  return warming
}
export function resetStoreWarmForTest(): void { warming = null }
