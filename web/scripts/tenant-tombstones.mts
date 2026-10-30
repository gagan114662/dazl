// The tombstone ledger beside the backups (issue #359 part 3; docs/TENANT-LIFECYCLE.md "Backups"). Run by the operator.
//   node --experimental-strip-types --no-warnings scripts/tenant-tombstones.mts check --db APP.db --ledger LEDGER.jsonl
//     every completed deletion in the live store is in the ledger (exit 1 if one is missing); read-only
//   ... export --db APP.db --out LEDGER.jsonl      write the ledger from the live store (to rebuild a lost file)
//   ... reapply --db RESTORED.db --ledger LEDGER.jsonl [--confirm]
//     on a RESTORED copy, before it serves: lists the ledgered deletions it is missing; --confirm re-applies them
//   ... exposure --ledger LEDGER.jsonl --backups DIR [--expire-days N]
//     which backups (create-backup .db files with their .json sidecar) may still hold erased tenants, and which are past
//     the owner's backup expiry (exit 1 when any is overdue). Reports only: no backup is deleted here.
import Database from 'better-sqlite3'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { sqliteDb } from '../lib/db/client.ts'
import { reapplyTombstones } from '../lib/tenant/lifecycle.ts'
import { backupExposure, ledgerFromStore, planReapply, readLedger } from '../lib/tenant/ledger.ts'

const arg = (f: string) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : undefined }
const die = (m: string): never => { console.error(`tenant-tombstones: ${m}`); process.exit(2) }
const cmd = process.argv[2]
const store = (readonly: boolean) => sqliteDb(new Database(arg('--db') ?? die('--db is required'), { fileMustExist: true, readonly }))

if (cmd === 'check') {
  const live = (await ledgerFromStore(store(true))).map(l => JSON.parse(l).deleted_tenant as string)
  const have = new Set(readLedger(arg('--ledger') ?? die('--ledger is required')).map(e => e.deleted_tenant))
  const missing = live.filter(t => !have.has(t))
  console.log(JSON.stringify({ completed_deletions: live.length, ledgered: live.length - missing.length, missing }))
  process.exit(missing.length ? 1 : 0)
} else if (cmd === 'export') {
  const lines = await ledgerFromStore(store(true))
  writeFileSync(arg('--out') ?? die('--out is required'), lines.map(l => l + '\n').join(''), { mode: 0o600 })
  console.log(`tenant-tombstones: ${lines.length} deletion(s) written`)
} else if (cmd === 'reapply') {
  const ledger = readLedger(arg('--ledger') ?? die('--ledger is required'))
  const db = store(!process.argv.includes('--confirm'))
  const plan = await planReapply(db, ledger)
  if (!process.argv.includes('--confirm')) {
    console.log(JSON.stringify({ dry_run: true, missing: plan.missing.map(e => e.deleted_tenant), already: plan.already }))
    console.error('tenant-tombstones: dry run; add --confirm to re-apply on this restored copy')
  } else {
    const done = await reapplyTombstones(db, plan.missing.map(e => JSON.stringify(e)))
    console.log(JSON.stringify({ reapplied: done, already: plan.already }))
  }
} else if (cmd === 'exposure') {
  const dir = arg('--backups') ?? die('--backups DIR is required')
  const backups = (existsSync(dir) ? readdirSync(dir) : []).filter(f => f.endsWith('.db') && existsSync(path.join(dir, f + '.json'))).map(f => {
    const side = JSON.parse(readFileSync(path.join(dir, f + '.json'), 'utf8')) as { createdAt?: string }
    return { name: f, created_at: Math.floor(Date.parse(side.createdAt ?? '') / 1000) }
  }).filter(b => Number.isFinite(b.created_at))
  const days = arg('--expire-days')
  const r = backupExposure(readLedger(arg('--ledger') ?? die('--ledger is required')), backups, { now: Math.floor(Date.now() / 1000), expireDays: days === undefined ? null : Number(days) })
  console.log(JSON.stringify(r, null, 2))
  process.exit(r.overdue ? 1 : 0)
} else die('usage: tenant-tombstones.mts check|export|reapply|exposure (see the header)')
