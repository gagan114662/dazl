// Restore drill: prove a backup FILE is restorable, without touching the app.
//   node --experimental-strip-types scripts/backup/restore-drill.ts --backup /var/backups/dazl/dazl-backup-<ts>.db
// Restores into a throwaway work dir it can prove it owns, checks integrity, and compares
// schema + per-table row counts + content hashes between the backup and the restored copy.
// Exit 0 = pass, 1 = verification failed, 2 = usage/guard refusal. See web/docs/backup-runbook.md.
import { restoreDrill, GuardError } from './lib.ts'

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const backup = arg('--backup')
const workDir = arg('--work-dir')
const keepWorkDir = process.argv.includes('--keep-work-dir')
const asJson = process.argv.includes('--json')

if (!backup || process.argv.includes('--help')) {
  console.error('usage: restore-drill.ts --backup <file.db> [--work-dir <dir>] [--keep-work-dir] [--json]')
  process.exit(2)
}

try {
  const r = await restoreDrill({ backupPath: backup, workDir, keepWorkDir })
  if (asJson) {
    console.log(JSON.stringify(r, null, 2))
  } else {
    console.log(`restore drill: ${r.verdict.toUpperCase()}  (${r.durationMs}ms)`)
    console.log(`  backup:  ${r.backupPath}`)
    console.log(`  sha256:  ${r.backupSha256Before}`)
    console.log(`  sidecar manifest: ${r.sidecarVerified === null ? 'none found' : r.sidecarVerified ? 'verified' : 'MISMATCH'}`)
    console.log(`  tables compared, backup vs restored: ${r.tablesChecked}`)
    if (r.sourceMetrics) {
      console.log(`  integrity_check: ${r.sourceMetrics.integrityOk ? 'ok' : 'FAILED'}`)
      for (const t of r.sourceMetrics.tables) console.log(`    ${t.name}: ${t.rows ?? '?'} rows${t.note ? ` (${t.note})` : ''}`)
    }
    for (const w of r.warnings) console.log(`  warning: ${w}`)
    for (const reason of r.reasons) console.log(`  FAIL: ${reason}`)
    console.log(`  backup file unchanged by drill: ${r.backupUnchangedAfterDrill}`)
    if (r.workDirKept) console.log(`  restored copy kept at: ${r.workDirKept}`)
  }
  process.exit(r.verdict === 'pass' ? 0 : 1)
} catch (e) {
  console.error(e instanceof GuardError ? `refused: ${e.message}` : `drill failed: ${(e as Error).message}`)
  process.exit(e instanceof GuardError ? 2 : 1)
}
