// Create a consistent backup of the app SQLite DB while the app keeps running.
//   node --experimental-strip-types scripts/backup/create-backup.ts --source "$DB_PATH" --dest-dir /var/backups/dazl
// (node >= 22.18 strips types natively; the flag is harmless either way)
// Safe by construction: source opened read-only, snapshot via the SQLite online backup
// API (WAL-safe), never overwrites, result is integrity-checked and normalized to a
// single self-contained file. See web/docs/backup-runbook.md.
import path from 'node:path'
import { createBackup, GuardError } from './lib.ts'

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const source = arg('--source') ?? process.env.DB_PATH ?? path.join(process.cwd(), '..', '..', 'dazl-data', 'app.db')
const destDir = arg('--dest-dir')
const asJson = process.argv.includes('--json')

if (!destDir || process.argv.includes('--help')) {
  console.error('usage: create-backup.ts --dest-dir <dir> [--source <app.db>] [--json]')
  console.error('source resolution: --source > $DB_PATH > ../../dazl-data/app.db (printed in the report)')
  process.exit(2)
}

try {
  const result = await createBackup({ source, destDir })
  if (asJson) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log(`backup written: ${result.backupPath}`)
    console.log(`  source:   ${result.sourcePath}`)
    console.log(`  bytes:    ${result.bytes}`)
    console.log(`  sha256:   ${result.sha256}`)
    console.log(`  sidecar:  ${result.sidecarPath}`)
    console.log(`  took:     ${result.durationMs}ms`)
    console.log(`next step: run the restore drill on it:  restore-drill.ts --backup "${result.backupPath}"`)
  }
} catch (e) {
  console.error(e instanceof GuardError ? `refused: ${e.message}` : `backup failed: ${(e as Error).message}`)
  process.exit(e instanceof GuardError ? 2 : 1)
}
