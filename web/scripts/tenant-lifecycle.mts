// Operator controls for the tenant deletion lifecycle (#359 part 2). Not reachable from the web app.
//
//   cd web && DAZL_DB_PATH=<sqlite file> node --experimental-strip-types scripts/tenant-lifecycle.mts --list
//   ... --resume --tenant <id> --confirm <id again> --operator "<name>" [--execute]
//   ... --reapply --ledger <file of ledger lines> [--execute]
//
// --list prints every tombstone (state, requester, retained counts). --resume drives a stalled deletion to
// completion under its recorded policy (DRY RUN without --execute prints the current state only). --reapply
// re-runs the off-database ledger after a restore; a restored store must not serve until every line applies.
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { deleteTenant, reapplyTombstones, tombstone, TombstoneReapplyError } from '../lib/tenant/lifecycle.ts'

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined }
const file = process.env.DAZL_DB_PATH
if (!file) { console.error('DAZL_DB_PATH (the sqlite file) is required'); process.exit(2) }
const raw = new Database(file); migrateAllSqlite(raw)
const db = sqliteDb(raw)
const execute = process.argv.includes('--execute')
try {
  if (process.argv.includes('--list')) {
    const rows = raw.prepare('SELECT deleted_tenant, requested_at, requested_by, state, retained, completed_at FROM tenant_tombstones ORDER BY requested_at').all()
    console.log(JSON.stringify(rows, null, 2)); process.exit(0)
  }
  if (process.argv.includes('--resume')) {
    const tenant = arg('tenant') ?? '', confirm = arg('confirm') ?? '', operator = arg('operator') ?? ''
    if (!tenant || tenant !== confirm) { console.error('--tenant and --confirm must both name the tenant exactly'); process.exit(2) }
    if (!operator) { console.error('--operator "<your name>" is required (the audit record names who resumed)'); process.exit(2) }
    const t = await tombstone(db, tenant)
    if (!t) { console.error('no deletion is recorded for this tenant'); process.exit(1) }
    if (!execute) { console.log(JSON.stringify({ dryRun: true, state: t.state, policy: JSON.parse(t.policy) })); console.log('dry run: nothing changed. Re-run with --execute to resume.'); process.exit(0) }
    const done = await deleteTenant(db, tenant) // resumes under the recorded policy
    console.log(JSON.stringify({ state: done.state, retained: done.retained ? JSON.parse(done.retained) : null, completed_at: done.completed_at }))
    process.exit(done.state === 'completed' ? 0 : 1)
  }
  if (process.argv.includes('--reapply')) {
    const ledger = arg('ledger')
    if (!ledger) { console.error('--ledger <file> is required (one ledger line per row)'); process.exit(2) }
    const lines = readFileSync(ledger, 'utf8').split('\n').map(x => x.trim()).filter(Boolean)
    if (!execute) { console.log(JSON.stringify({ dryRun: true, lines: lines.length })); console.log('dry run: nothing changed. Re-run with --execute to re-apply.'); process.exit(0) }
    try {
      const applied = await reapplyTombstones(db, lines)
      console.log(JSON.stringify({ applied })); process.exit(0)
    } catch (e) {
      if (e instanceof TombstoneReapplyError) { console.error(JSON.stringify({ failed: e.failed, applied: e.applied })); process.exit(1) }
      throw e
    }
  }
  console.error('one of --list, --resume or --reapply is required'); process.exit(2)
} finally { await db.close() }
