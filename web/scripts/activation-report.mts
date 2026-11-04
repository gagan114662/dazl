// #409: the website-first onboarding funnel for workspaces created in a window - how many reached each stage, where the
// rest stopped, how their first website read went (own key, free trial, facts-only read and why), and the time to the
// first verified lead (lib/scan/activation.ts). Read-only; runs on the host with the app's store.
//
//   cd web && node --experimental-strip-types --no-warnings scripts/activation-report.mts [--days N] [--json]
//     --days N   workspaces created in the last N days (default 30, at most 3650)
//     --json     the raw report instead of the table
//
// Stores: DATABASE_URL (Postgres) or DB_PATH (SQLite) for workspaces and the audit trail. Scans still run on the SQLite
// store while the app reads Postgres (lib/scan/service.ts), so scan_jobs and leads are read there.
import { getDb, sqliteDb } from '../lib/db/client.ts'
import { getAuthDb } from '../lib/auth-db.ts'
import { activationReport, formatActivation } from '../lib/scan/activation.ts'

const args = process.argv.slice(2)
const i = args.indexOf('--days')
const raw = i >= 0 ? args[i + 1] ?? '' : '30'
if (!/^\d{1,4}$/.test(raw) || Number(raw) < 1 || Number(raw) > 3650) { console.error('usage: activation-report.mts [--days 1..3650] [--json]'); process.exit(2) }
const until = Math.floor(Date.now() / 1000) + 1
const report = await activationReport(await getDb(), sqliteDb(getAuthDb()), { since: until - Number(raw) * 86400, until })
console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : formatActivation(report))
process.exit(report.unknown > 0 ? 1 : 0)
