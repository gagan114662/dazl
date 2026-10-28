// Insertion order as a tie-break, for queries ported from the raw handle that relied on SQLite's rowid.
// On SQLite it is rowid, so a ported query orders exactly as the raw one did. Postgres has no rowid: there it is the
// row's id, which keeps the order deterministic but is NOT insertion order. Every caller is listed in
// PG_INSERTION_ORDER_GAPS (lib/db/pg-port-status.ts) until its table has a real insertion-order column, a cutover
// prerequisite (docs/PLATFORM.md "Postgres cutover"). The audit (lib/db/sql-audit.ts) checks the Postgres form.
import type { Db } from './client.ts'

export function insertionOrder(kind: Db['kind'], alias?: string): string {
  const a = alias ? `${alias}.` : ''
  return kind === 'sqlite' ? `${a}rowid` : `${a}id`
}
