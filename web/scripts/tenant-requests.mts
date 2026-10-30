// Operator side of tenant data requests (issue #359; docs/TENANT-LIFECYCLE.md "Requests"). Run on the host by the
// operator the owner names (decision 7). Nothing is deleted without --confirm; without it, execute prints a dry run.
//   node --experimental-strip-types --no-warnings scripts/tenant-requests.mts list [--status pending] --db APP.db
//   ... execute --request req_... --operator NAME --policy POLICY.json [--confirm --ledger LEDGER.jsonl] --db APP.db
//     --confirm needs --ledger: the completed deletion is appended to the tombstone ledger kept beside the backups
//     (lib/tenant/ledger.ts), so a restored backup can have it re-applied
//   ... refuse --request req_... --operator NAME --note "why" --db APP.db
// POLICY.json is the explicit retention policy (lib/tenant/lifecycle.ts DeletionPolicy), e.g.
//   {"suppressions":"retain","retainTables":["tenant_requests"]}
// There is no default policy: the owner's retention decisions are not made yet.
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { sqliteDb } from '../lib/db/client.ts'
import { executeDeletion, listRequests, refuseRequest, type TenantRequest } from '../lib/tenant/requests.ts'
import { appendLedger } from '../lib/tenant/ledger.ts'

const arg = (f: string) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : undefined }
const die = (m: string): never => { console.error(`tenant-requests: ${m}`); process.exit(2) }
const file = arg('--db') ?? process.env.DB_PATH ?? die('--db APP.db is required')
const cmd = process.argv[2]
const raw = new Database(file, { fileMustExist: true, readonly: cmd === 'list' })
const db = sqliteDb(raw)
if (cmd === 'list') {
  const rows = await listRequests(db, arg('--status') as TenantRequest['status'] | undefined)
  console.log(JSON.stringify(rows, null, 2))
} else if (cmd === 'execute') {
  const policy = JSON.parse(readFileSync(arg('--policy') ?? die('--policy POLICY.json is required (no default)'), 'utf8'))
  const ledger = arg('--ledger')
  if (process.argv.includes('--confirm') && !ledger) die('--confirm needs --ledger LEDGER.jsonl: a deletion is never carried out without its off-database record')
  const r = await executeDeletion(db, arg('--request') ?? die('--request is required'), { operator: arg('--operator') ?? die('--operator is required'), policy, confirm: process.argv.includes('--confirm') })
  if ('executed' in r) (r as Record<string, unknown>).ledger = appendLedger(ledger!, r.executed)
  console.log(JSON.stringify(r, null, 2))
  if ('dry_run' in r) console.error('tenant-requests: dry run only; nothing was changed. Add --confirm --ledger FILE to delete.')
} else if (cmd === 'refuse') {
  const ok = await refuseRequest(db, arg('--request') ?? die('--request is required'), arg('--operator') ?? die('--operator is required'), arg('--note') ?? die('--note is required'))
  if (!ok) die('no pending deletion request with that id'); console.log('refused')
} else die('usage: tenant-requests.mts list|execute|refuse (see the header)')
