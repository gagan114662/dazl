// Restore drill: prove a backup FILE is restorable, without touching the app.
//   node --experimental-strip-types scripts/backup/restore-drill.ts --backup /var/backups/dazl/dazl-backup-<ts>.db [--report OUT.json]
// Restores into a throwaway work dir it can prove it owns, checks integrity, and compares
// schema + per-table row counts + content hashes between the backup and the restored copy.
// --report OUT.json writes the report backup-check.mts's drill leg reads (tool, started_at, ok, steps, reasons,
// warnings), on failure too: a failed drill must leave a fresh FAILING report, not silence. Written mode 600 via a
// .partial rename, so the monitor never reads a half-written report. A demanded report that cannot be written fails
// the run (a report the monitor cannot see is the drill leg going blind). Exit 0 = pass, 1 = verification failed
// (or the report could not be written), 2 = usage/guard refusal. See web/docs/backup-runbook.md.
import path from 'node:path'
import { renameSync, writeFileSync } from 'node:fs'
import { restoreDrill, GuardError, type DrillReport } from './lib.ts'

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const backup = arg('--backup')
const workDir = arg('--work-dir')
const keepWorkDir = process.argv.includes('--keep-work-dir')
const asJson = process.argv.includes('--json')
const reportPath = arg('--report')

if (!backup || process.argv.includes('--help')) {
  console.error('usage: restore-drill.ts --backup <file.db> [--work-dir <dir>] [--keep-work-dir] [--json] [--report <out.json>]')
  process.exit(2)
}

const startedAt = Date.now()
let r: DrillReport | null = null
let thrown: Error | null = null
let exitCode = 0
try {
  r = await restoreDrill({ backupPath: backup, workDir, keepWorkDir })
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
  exitCode = r.verdict === 'pass' ? 0 : 1
} catch (e) {
  thrown = e as Error
  console.error(e instanceof GuardError ? `refused: ${e.message}` : `drill failed: ${(e as Error).message}`)
  exitCode = e instanceof GuardError ? 2 : 1
}

if (reportPath) {
  const report = r
    ? {
        tool: 'dazl-restore-drill',
        started_at: new Date(startedAt).toISOString(),
        ok: r.verdict === 'pass',
        steps: r.steps,
        reasons: r.reasons,
        warnings: r.warnings,
        duration_ms: r.durationMs,
        backup: path.basename(r.backupPath),
      }
    : {
        tool: 'dazl-restore-drill',
        started_at: new Date(startedAt).toISOString(),
        ok: false,
        steps: [{ step: 'restore drill', ok: false }],
        reasons: [thrown?.message ?? 'drill failed'],
        warnings: [],
        duration_ms: Date.now() - startedAt,
        backup: path.basename(backup),
      }
  try {
    writeFileSync(reportPath + '.partial', JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
    renameSync(reportPath + '.partial', reportPath)
  } catch (e) {
    console.error(
      `restore-drill: the drill report could not be written to ${reportPath} (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}); ` +
        'the monitor keeps judging the previous report until it goes stale',
    )
    if (exitCode === 0) exitCode = 1
  }
}
process.exit(exitCode)
