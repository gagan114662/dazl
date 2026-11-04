// Send gate for a restored store (issue #360; docs/RECOVERY.md step 8). Sending stays disabled on a restored host
// (AUTOPILOT_KILL=1, no tick secret) until this exits 0: every claim still 'sending', every 'uncertain' message,
// sequence and follow-up step is decided (resolveUncertain: mark_sent or retry), and every worker lease taken on the
// old host has expired. Read-only; counts only.
//   node --experimental-strip-types scripts/backup/send-gate.mts --db /var/lib/dazl-next/app.db
// Exit 0 = sending may be re-enabled; 1 = blocked (the counts that block are named); 2 = usage or unreadable store
// (an unreadable store, or one missing a table the gate counts, is never "clear").
import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { blockers, missingTables, sendSafety } from './send-safety.mts'

const i = process.argv.indexOf('--db'), db = i >= 0 ? process.argv[i + 1] : undefined
if (!db || db.startsWith('--')) { console.error('usage: send-gate.mts --db FILE'); process.exit(2) }
if (!existsSync(db)) { console.error('send-gate: no such database: refusing to call it clear'); process.exit(2) }
let counts
try {
  const h = new Database(db, { readonly: true, fileMustExist: true })
  let missing: string[] = []
  try { missing = missingTables(h); if (!missing.length) counts = sendSafety(h) } finally { h.close() }
  if (missing.length) { console.error(`send-gate: not a current dazl store (no ${missing.join(', ')} table): refusing to call it clear`); process.exit(2) }
} catch (e) { console.error(`send-gate: database unreadable (${(e as { code?: string }).code ?? (e instanceof Error ? e.name : 'error')}): refusing to call it clear`); process.exit(2) }
if (!counts) { console.error('send-gate: no counts: refusing to call it clear'); process.exit(2) }
const b = blockers(counts)
console.log(JSON.stringify({ type: 'send_gate', sending_may_be_enabled: b.length === 0, blocked_by: b, ...counts }))
if (b.length) console.error(`send-gate: keep AUTOPILOT_KILL=1 and the tick secret off: reconcile ${b.join(', ')} first`)
process.exit(b.length ? 1 : 0)
