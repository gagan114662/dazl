// Postgres backup (issue #360, part 3; docs/RECOVERY.md "Postgres cutover"): pg_dump -Fc plus a sidecar with the dump's
// sha256 and a content fingerprint from the same snapshot (scripts/backup/pg-lib.ts). Not scheduled anywhere: the
// SQLite backup stays the production path until the cutover.
//   DATABASE_URL=postgres://... node --experimental-strip-types scripts/backup/pg-backup.mts --dest DIR
// Exit 0 = backup and sidecar written; 1 = failed; 2 = usage.
import { createPgBackup } from './pg-lib.ts'

const arg = (f: string) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : undefined }
const dest = arg('--dest'), url = process.env.DATABASE_URL
if (!dest || !url) { console.error('usage: DATABASE_URL=postgres://... pg-backup.mts --dest DIR'); process.exit(2) }
try {
  const { backupPath, sidecar } = await createPgBackup({ url, destDir: dest })
  const rows = Object.values(sidecar.tables).reduce((a, t) => a + t.rows, 0)
  console.log(`pg backup written: ${backupPath} (${sidecar.bytes} bytes, ${Object.keys(sidecar.tables).length} tables, ${rows} rows, sha256 ${sidecar.sha256.slice(0, 12)}…)`)
} catch (e) { console.error(`pg-backup: ${e instanceof Error ? e.message : String(e)}`); process.exit(1) }
