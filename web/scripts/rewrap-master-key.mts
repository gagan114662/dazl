// Master-key rotation tool (fixture-rehearsed before any production use).
// Reads the CURRENT key from DAZL_MASTER_KEY and the NEXT key from
// DAZL_MASTER_KEY_NEXT, re-wraps every registered ciphertext column, and prints
// counts only - never key, blob, or plaintext material.
//   node --experimental-strip-types scripts/rewrap-master-key.mts --db /path/to.db [--dry-run]
// Reverse direction (rollback) = the same tool with the two env values swapped.
import Database from 'better-sqlite3'
import { getMasterKey } from '../lib/secrets.ts'
import { rewrapMasterKey } from '../lib/secrets-rewrap.ts'

const args = process.argv.slice(2)
const dbPath = args[args.indexOf('--db') + 1]
const dryRun = args.includes('--dry-run')
if (!dbPath || dbPath.startsWith('--')) { console.error('usage: rewrap-master-key.mts --db <path> [--dry-run]'); process.exit(2) }
const oldMaster = getMasterKey()
const rawNext = process.env.DAZL_MASTER_KEY_NEXT
if (!rawNext) { console.error('DAZL_MASTER_KEY_NEXT is not set'); process.exit(2) }
const newMaster = Buffer.from(rawNext, 'base64')
if (newMaster.length !== 32) { console.error('DAZL_MASTER_KEY_NEXT must be base64 of exactly 32 bytes'); process.exit(2) }

const db = new Database(dbPath)
try {
  const results = rewrapMasterKey(db, oldMaster, newMaster, { dryRun })
  for (const r of results) console.log(`${r.table}.${r.column}: ${r.missing ? 'table missing - nothing to do' : `${r.rewrapped} rewrapped, ${r.skipped} already current`}${dryRun ? ' (dry run - nothing written)' : ''}`)
} catch (e) {
  console.error(`rewrap ABORTED (fail closed): ${e instanceof Error ? e.message : 'error'}`)
  process.exit(1)
} finally { db.close() }
