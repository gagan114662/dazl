// Master-key rotation tool (fixture-rehearsed before any production use).
// Reads the CURRENT key from DAZL_MASTER_KEY and the NEXT key from
// DAZL_MASTER_KEY_NEXT, re-wraps every registered ciphertext column, and prints
// counts only - never key, blob, or plaintext material.
//   node --experimental-strip-types scripts/rewrap-master-key.mts --db /path/to.db [--dry-run] [--verify] [--quarantine-corrupt]
// Reverse direction (rollback) = the same tool with the two env values swapped.
// --dry-run and --verify open the database READ-ONLY (no sidecar writes).
// A real run exits 0 ONLY when the post-run gate passes: every row is
// wrap-verified under the new key (bad = 0) AND a read-only re-check shows 0
// rows would change and 0 corrupt. Corrupt rows (quarantine mode) ALWAYS fail the gate:
// they are unknown-affected tenants needing loud manual review, never "ready".
import Database from 'better-sqlite3'
import { getMasterKey } from '../lib/secrets.ts'
import { rewrapMasterKey, verifyMasterKey } from '../lib/secrets-rewrap.ts'

const args = process.argv.slice(2)
const dbPath = args[args.indexOf('--db') + 1]
const dryRun = args.includes('--dry-run')
const verifyOnly = args.includes('--verify')
const quarantine = args.includes('--quarantine-corrupt')
if (!dbPath || dbPath.startsWith('--')) { console.error('usage: rewrap-master-key.mts --db <path> [--dry-run] [--verify] [--quarantine-corrupt]'); process.exit(2) }
const oldMaster = getMasterKey()
const readOnly = dryRun || verifyOnly
const db = new Database(dbPath, { readonly: readOnly })
try {
  if (verifyOnly) {
    const results = verifyMasterKey(db, oldMaster)
    let bad = 0
    for (const r of results) { bad += r.bad; console.log(`${r.table}.${r.column}: ${r.missing ? 'table missing' : `${r.ok}/${r.total} wraps open under DAZL_MASTER_KEY${r.bad ? `, ${r.bad} DO NOT` : ''}`}`) }
    if (bad > 0) { console.error(`verify FAILED: ${bad} wrap(s) do not open under the given key - unknown-affected tenants, manual review required`); process.exit(1) }
    console.log('verify OK: every row is wrap-verified under DAZL_MASTER_KEY (wrap-only check - bodies never decrypted)')
    process.exit(0)
  }
  const rawNext = process.env.DAZL_MASTER_KEY_NEXT
  if (!rawNext) { console.error('DAZL_MASTER_KEY_NEXT is not set'); process.exit(2) }
  const newMaster = Buffer.from(rawNext, 'base64')
  if (newMaster.length !== 32) { console.error('DAZL_MASTER_KEY_NEXT must be base64 of exactly 32 bytes'); process.exit(2) }
  if (quarantine) console.error('WARNING: --quarantine-corrupt is a recovery mode - corrupt rows will be skipped and counted, NOT repaired')
  const results = rewrapMasterKey(db, oldMaster, newMaster, { dryRun, quarantineCorrupt: quarantine })
  for (const r of results) console.log(`${r.table}.${r.column}: ${r.missing ? 'table missing - nothing to do' : `${r.rewrapped} rewrapped, ${r.skipped} already current${r.corrupt ? `, ${r.corrupt} CORRUPT (unknown-affected - manual review)` : ''}`}${dryRun ? ' (dry run - nothing written)' : ''}`)
  if (dryRun) process.exit(0)
  // Post-run gate: every row's wrap must open under the new key AND a
  // read-only re-check must show 0 would-change and 0 corrupt. Any failure
  // exits 1. Wrap-only: bodies are never decrypted in the audit path.
  const verify = verifyMasterKey(db, newMaster)
  const bad = verify.reduce((n, r) => n + r.bad, 0)
  const total = verify.reduce((n, r) => n + r.total, 0)
  if (bad > 0) { console.error(`post-run gate FAILED: ${bad}/${total} wrap(s) do not open under the new key - do NOT swap env; unknown-affected tenants need manual review`); process.exit(1) }
  let wouldChange = 0, corrupt = 0
  try {
    const recheck = rewrapMasterKey(db, oldMaster, newMaster, { dryRun: true })
    wouldChange = recheck.reduce((n, r) => n + r.rewrapped, 0)
    corrupt = recheck.reduce((n, r) => n + r.corrupt, 0)
  } catch { console.error('post-run gate FAILED: read-only re-check hit unrewrappable rows - do NOT swap env'); process.exit(1) }
  if (wouldChange > 0 || corrupt > 0) { console.error(`post-run gate FAILED: ${wouldChange} row(s) would still change, ${corrupt} corrupt - do NOT swap env`); process.exit(1) }
  console.log(`post-run gate PASSED: ${total} row(s) wrap-verified under the new key (bodies untouched), 0 would change, 0 corrupt - env swap gate cleared (operator decision remains)`)
} catch (e) {
  console.error(`rewrap ABORTED (fail closed): ${e instanceof Error ? e.message : 'error'}`)
  process.exit(1)
} finally { db.close() }
