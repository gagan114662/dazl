// Dazl's own acquisition funnel (issue #404; lib/growth/lifecycle.ts holds every definition). Read-only: it opens the
// SQLite store read-only, writes nothing and sends nothing anywhere. Prints JSON, or a table with --markdown.
//   node --experimental-strip-types --no-warnings scripts/funnel.mts --db /path/to/app.db [--markdown] [--tenants]
//     [--exclude id1,id2] [--now <unix seconds>]
// --tenants adds the per-tenant rows (ids and stages only: no email, no lead or payment detail).
import Database from 'better-sqlite3'
import { sqliteDb } from '../lib/db/client.ts'
import { funnelReport, tenantFunnels, type FunnelRow } from '../lib/growth/lifecycle.ts'

const arg = (f: string) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : undefined }
const file = arg('--db') ?? process.env.DB_PATH
if (!file) { console.error('usage: funnel.mts --db APP.db [--markdown] [--tenants] [--exclude a,b] [--now SECONDS]'); process.exit(2) }
const now = Number(arg('--now') ?? Math.floor(Date.now() / 1000))
const raw = new Database(file, { readonly: true, fileMustExist: true })
const tenants = await tenantFunnels(sqliteDb(raw), { now, excludeTenants: arg('--exclude')?.split(',').filter(Boolean) })
const report = funnelReport(tenants, now)
const rows = process.argv.includes('--tenants') ? tenants.map(t => ({ tenant_id: t.tenant_id, source: t.source, stage: t.stage, real_leads: t.real_leads, payments: t.payments, retained: t.retained })) : undefined
if (!process.argv.includes('--markdown')) { console.log(JSON.stringify({ ...report, tenants: rows }, null, 2)); process.exit(0) }
const pct = (n: number, d: number) => d ? `${Math.round((n / d) * 100)}%` : 'n/a'
const line = (r: FunnelRow) => `| ${r.source} | ${r.signed_up} | ${r.activated} (${pct(r.activated, r.signed_up)}) | ${r.repeat} | ${r.paid} (${pct(r.paid, r.signed_up)}) | ${r.retained} of ${r.retention_mature} mature (${pct(r.retained, r.retention_mature)}) | ${r.churned} | ${r.signed_up_only} | ${r.zero_result} | ${r.payment_failed} | ${r.refunded} |`
console.log([
  `# Dazl acquisition funnel, as of ${new Date(now * 1000).toISOString()}`, '',
  `${report.excluded_tenants} synthetic or staging tenant(s) excluded. Source coverage: ${report.source_coverage.tagged} tagged, ${report.source_coverage.unknown} unknown.`, '',
  '| Source | Signed up | Activated | Repeat | Paid | Retained | Churned | No scan | Scans, no real lead | Payment failed | Refunded |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  line(report.total), ...report.by_source.map(line), '', report.note,
  ...(rows ? ['', '| Tenant | Source | Stage |', '| --- | --- | --- |', ...rows.map(r => `| ${r.tenant_id} | ${r.source} | ${r.stage} |`)] : []),
].join('\n'))
