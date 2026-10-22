// Synthetic SQLite->Postgres migration rehearsal for the leads-read slice tables.
// Builds a synthetic SQLite DB at parameterized volume (NO production data), copies
// every row into a Postgres loaded with schema.sql, then verifies per-table row
// counts and full-content equality (sorted dump comparison). Prints a divergence
// report. Run:
//   DAZL_PG_SLICE=postgres://user:pass@127.0.0.1:55433/postgres node --experimental-strip-types scripts/pg-migrate/rehearse.ts
// Env knobs: REHEARSE_TENANTS, REHEARSE_JOBS, REHEARSE_LEADS (per job).
import Database from 'better-sqlite3'
import { Client } from 'pg'
import { migrateScan } from '../../lib/scan/store.ts'
import { migrateEvents } from '../../lib/events/store.ts'
import { migrateOutreach } from '../../lib/outreach/store.ts'
import { migrateSequences } from '../../lib/outreach/sequences.ts'
import { migrateConnectors } from '../../lib/connectors/store.ts'
import { migrateReplies } from '../../lib/outreach/replies.ts'

const PG_ADMIN = process.env.DAZL_PG_ADMIN
if (!PG_ADMIN) { console.error('DAZL_PG_ADMIN (loopback maintenance URL) required - the script provisions its own guarded dazl_rehearse_* target'); process.exit(1) }
const TENANTS = Number(process.env.REHEARSE_TENANTS ?? 5)
const JOBS = Number(process.env.REHEARSE_JOBS ?? 4)
const LEADS = Number(process.env.REHEARSE_LEADS ?? 25)

const db = new Database('/tmp/rehearse-synthetic.db')
db.exec('DROP TABLE IF EXISTS leads; DROP TABLE IF EXISTS scan_jobs')
for (const t of ['lead_enrichments','company_events','sequence_steps','sequences','outreach_messages','sequence_settings','inbound_messages','suppressions']) db.exec(`DROP TABLE IF EXISTS ${t}`)
migrateScan(db); migrateEvents(db); migrateOutreach(db); migrateSequences(db); migrateConnectors(db); migrateReplies(db)

const jobId = (t: number, j: number) => `job${String(t).padStart(4, '0')}${String(j).padStart(10, '0')}`.slice(0, 24)
let leadCount = 0
const insJob = db.prepare("INSERT INTO scan_jobs (id, user_id, status, business_name, industry, location, created_at, query, candidates, verified, needs_review, dropped) VALUES (?, ?, 'running', ?, 'software', 'Toronto', ?, 'synthetic query', ?, ?, ?, ?)")
const insLead = db.prepare("INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, score, created_at, fit, intent, action, company_domain, evidence_excerpt, confidence, review_reason) VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
const insEnr = db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES (?, ?, ?, 'apollo', 'person', ?, 'Role', 80, 'https://apollo.io/x', '2026-10-01', 3000)")
const insEvt = db.prepare("INSERT INTO company_events (id, tenant_id, company_key, company_name, scope, lead_id, event_type, summary, detail, source_url, source_published_at, retrieved_at, first_seen_at, last_seen_at, confidence) VALUES (?, ?, ?, ?, 'account', ?, 'hiring_surge', 'Hiring', NULL, 'https://news.example/a', '2026-10-01', 4000, 3900, 4000, 70)")
const insMsg = db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, created_at) VALUES (?, ?, ?, ?, 'subj', '01234567890123456789', 'sent', 1000, 999)")
const insSeq = db.prepare("INSERT INTO sequences (id, tenant_id, lead_id, message_id, to_email, status, created_at) VALUES (?, ?, ?, ?, ?, 'active', 998)")
const insStep = db.prepare("INSERT INTO sequence_steps (tenant_id, sequence_id, step, subject, body, status, sent_at, created_at) VALUES (?, ?, 2, 's2', '01234567890123456789', 'sent', 2000, 997)")
db.prepare("INSERT INTO sequence_settings (tenant_id, test_addresses) VALUES ('t-0', '[]')").run()

for (let t = 0; t < TENANTS; t++) {
  const tenant = `t-${t}`
  for (let j = 0; j < JOBS; j++) {
    const jid = jobId(t, j)
    insJob.run(jid, tenant, `Biz ${t}-${j}`, 1800000000 - j, LEADS, LEADS - 2, 2, 1)
    for (let k = 0; k < LEADS; k++) {
      const lid = `L-${t}-${j}-${k}`
      const fit = k % 5 === 0 ? 1 : 2 + (k % 4)
      insLead.run(lid, jid, `Company ${t}-${j}-${k}`, k % 3 === 0 ? `person${k}@co${t}${j}${k}.example` : null, `Hiring signal ${k} for sales ops`, `https://example.com/jobs/${k}`, 50 + (k % 50), 1800000000 - k, fit, 1 + (k % 5), 1 + (k % 5), k % 2 === 0 ? `co${t}${j}${k}.example` : null, k % 4 === 0 ? 'evidence excerpt' : null, k % 2 === 0 ? 70 : null, k % 11 === 0 ? 'job_closed' : null)
      leadCount++
      if (k % 7 === 0) insEnr.run(`E-${lid}`, lid, tenant, `Person ${k}`)
      if (k % 5 === 0) insEvt.run(`V-${lid}`, tenant, `co${t}${j}${k}.example`, `Company ${t}-${j}-${k}`, lid)
      if (k % 9 === 0) { insMsg.run(`M-${lid}`, tenant, lid, `p${k}@x.example`); insSeq.run(`S-${lid}`, tenant, lid, `M-${lid}`, `p${k}@x.example`); insStep.run(tenant, `S-${lid}`) }
    }
    db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(jid)
  }
}
console.log(`synthetic sqlite: ${TENANTS} tenants x ${JOBS} jobs x ${LEADS} leads = ${leadCount} leads`)

const TABLES = ['scan_jobs', 'leads', 'outreach_messages', 'sequences', 'sequence_steps', 'sequence_settings', 'lead_enrichments', 'company_events', 'suppressions', 'inbound_messages']
const { provisionRehearsalDb, assertRehearsalTarget, dropRehearsalDb } = await import('./guard.ts')
const prov = await provisionRehearsalDb(PG_ADMIN, 'rhz-' + Math.random().toString(36).slice(2))
console.log(`provisioned guarded target: ${prov.dbName}`)
const client = new Client({ connectionString: prov.url })
await client.connect()
await assertRehearsalTarget(client, prov.token)
await client.query((await import('node:fs')).readFileSync(new URL('./schema-full.generated.sql', import.meta.url), 'utf8'))
await assertRehearsalTarget(client, prov.token)

const divergences: string[] = []
process.on('exit', () => {})
for (const t of TABLES) {
  const rows = db.prepare(`SELECT * FROM ${t}`).all() as Record<string, unknown>[]
  if (rows.length === 0) continue
  const cols = Object.keys(rows[0])
  const pgCols = (await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [t])).rows.map((r: { column_name: string }) => r.column_name)
  const missing = cols.filter(c => !pgCols.includes(c))
  if (missing.length) divergences.push(`${t}: sqlite columns absent from pg slice schema: ${missing.join(', ')}`)
  const use = cols.filter(c => pgCols.includes(c))
  let inserted = 0
  for (const r0 of rows) {
    const r = { ...r0 }
    // leads_only_while_running trigger: copy jobs as 'running', restore after leads land
    if (t === 'scan_jobs') r.status = 'running'
    const ph = use.map((_, i) => `$${i + 1}`).join(',')
    try {
      await client.query(`INSERT INTO ${t} (${use.join(',')}) VALUES (${ph})`, use.map(c => r[c]))
      inserted++
    } catch (e) {
      divergences.push(`${t} insert failed: ${(e as Error).message.slice(0, 120)} row=${JSON.stringify(r).slice(0, 120)}`)
      if (divergences.length > 20) break
    }
  }
  if (inserted !== rows.length) divergences.push(`${t}: copied ${inserted}/${rows.length}`)
}

// restore real job statuses (running->done/failed are legal transitions)
const realStatuses = db.prepare('SELECT id, status FROM scan_jobs').all() as { id: string; status: string }[]
for (const j of realStatuses) {
  if (j.status !== 'running') await client.query('UPDATE scan_jobs SET status = $1 WHERE id = $2', [j.status, j.id])
}


for (const t of TABLES) {
  const sRows = db.prepare(`SELECT * FROM ${t}`).all() as Record<string, unknown>[]
  const pgCols = (await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [t])).rows.map((r: { column_name: string }) => r.column_name)
  const use = Object.keys(sRows[0] ?? {}).filter(c => pgCols.includes(c))
  const pRows = (await client.query(`SELECT ${use.length ? use.join(',') : '*'} FROM ${t}`)).rows as Record<string, unknown>[]
  // normalize both sides to strings: pg returns BIGINT (int8) as string, sqlite as number
  const norm = (rows: Record<string, unknown>[]) => rows.map(r => JSON.stringify((use.length ? use : Object.keys(r)).map(c => r[c] === null || r[c] === undefined ? null : String(r[c])))).sort()
  const a = norm(sRows), b = norm(pRows)
  if (a.length !== b.length) { divergences.push(`${t}: count sqlite=${a.length} pg=${b.length}`); continue }
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { divergences.push(`${t}: content mismatch row ${i}: ${a[i].slice(0, 150)} vs ${b[i].slice(0, 150)}`); break }
}

console.log(`divergences: ${divergences.length}`)
for (const d of divergences.slice(0, 20)) console.log(` - ${d}`)
console.log(divergences.length === 0 ? 'REHEARSAL CLEAN: slice tables copy losslessly (synthetic data)' : 'REHEARSAL DIVERGENCES ABOVE')
await client.end()
await dropRehearsalDb(PG_ADMIN, prov.dbName, prov.role)
console.log(`rehearsal target ${prov.dbName} dropped`)
