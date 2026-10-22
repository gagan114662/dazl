// FULL-SCHEMA synthetic migration rehearsal: every table, generated from the
// authoritative sqlite schema (extract-schema.ts output), copied to Postgres,
// verified by per-table counts AND full-content equality. Also rehearses the
// write-path guard: source frozen read-only during copy, write attempt fails
// cleanly, copy still verifies.
// Synthetic data only. No production data, no cutover authorization.
import Database from 'better-sqlite3'
import pg from 'pg'
import { readFileSync, copyFileSync, rmSync } from 'node:fs'

const SRC_TEMPLATE = process.env.FULL_SCHEMA_DB || '/tmp/full-schema.db'
const SRC = '/tmp/full-rehearse.db'
const PG_URL = process.env.DAZL_PG_FULL || process.env.DAZL_PG_SLICE
const ROWS = Number(process.env.REHEARSE_ROWS || 3)
if (!PG_URL) { console.error('set DAZL_PG_FULL'); process.exit(2) }

rmSync(SRC, { force: true }); rmSync(`${SRC}-wal`, { force: true }); rmSync(`${SRC}-shm`, { force: true })
copyFileSync(SRC_TEMPLATE, SRC)
const ddl = readFileSync(process.env.SQLITE_SCHEMA || '/tmp/full-schema.sql', 'utf8')

// Parse each table's column defs: name, type, notnull, dflt, pk + inline CHECK IN / LIKE.
const tables = [...ddl.matchAll(/CREATE TABLE (\w+) \(([\s\S]*?)\);/g)].map(m => ({ name: m[1], body: m[2] }))
type Col = { name: string; int: boolean; notnull: boolean; dflt: boolean; pk: boolean; inList?: string[]; like?: string; exactLen?: number; maxLen?: number; minLen?: number; intMin?: number; intMax?: number }
const fks: Record<string, { col: string; ref: string }[]> = {}
const cols: Record<string, Col[]> = {}
for (const t of tables) {
  const list: Col[] = []
  // split top-level commas (paren-depth aware; multi-column lines exist)
  const pieces: string[] = []
  let depth = 0, cur = ''
  for (const ch of t.body) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) { pieces.push(cur); cur = ''; continue }
    cur += ch
  }
  if (cur.trim()) pieces.push(cur)
  for (const raw of pieces) {
    const line = raw.trim()
    if (/^(PRIMARY KEY|UNIQUE|CHECK|CONSTRAINT|FOREIGN KEY)[\s(]/i.test(line)) continue
    const m = line.match(/^(\w+)\s+(TEXT|INTEGER|REAL|BLOB)([\s\S]*)$/i)
    if (!m) throw new Error(`unparsed column in ${t.name}: ${line.slice(0, 60)}`)
    const [, name, colType, restS] = m
    const inM = restS.match(/CHECK \([^)]*\bIN \(([^)]*)\)/i)
    const eqM = restS.match(/length\(\w+\) = (\d+)/i)
    const leM = restS.match(/length\(\w+\) <= (\d+)/i)
    const bwM = restS.match(/length\(\w+\) BETWEEN (\d+) AND (\d+)/i)
    const ibM = restS.match(/CHECK \(\w+ BETWEEN (\d+) AND (\d+)\)/i)
    const likeM = restS.match(/LIKE '([^']+)'/i)
    const refM = restS.match(/REFERENCES (\w+)/i)
    if (refM) (fks[t.name] ||= []).push({ col: name, ref: refM[1] })
    list.push({
      name, int: colType.toUpperCase() !== 'TEXT',
      notnull: /NOT NULL/i.test(restS), dflt: /DEFAULT/i.test(restS), pk: /PRIMARY KEY/i.test(restS),
      inList: inM ? [...inM[1].matchAll(/'([^']*)'/g)].map(x => x[1]) : undefined,
      like: likeM ? likeM[1].replace(/%/g, '') : undefined,
      exactLen: eqM ? Number(eqM[1]) : undefined,
      maxLen: leM ? Number(leM[1]) : undefined,
      minLen: bwM ? Number(bwM[1]) : undefined,
      intMin: ibM ? Number(ibM[1]) : undefined,
      intMax: ibM ? Number(ibM[2]) : undefined,
    })
  }
  // composite PK table-level
  const pkM = t.body.match(/PRIMARY KEY \(([^)]*)\)/i)
  if (pkM) for (const n of pkM[1].split(',').map(s => s.trim())) {
    const c = list.find(c => c.name === n); if (c) c.pk = true
  }
  cols[t.name] = list
  // FKs may also be table-level
  for (const fm of t.body.matchAll(/FOREIGN KEY \((\w+)\) REFERENCES (\w+)/gi)) {
    (fks[t.name] ||= []).push({ col: fm[1], ref: fm[2] })
  }
}

// FK-aware insert order (topo sort).
const order: string[] = []
const remaining = new Set(tables.map(t => t.name))
while (remaining.size) {
  let progressed = false
  for (const n of [...remaining]) {
    if ((fks[n] || []).every(f => !remaining.has(f.ref) || f.ref === n)) { order.push(n); remaining.delete(n); progressed = true }
  }
  if (!progressed) throw new Error('FK cycle among: ' + [...remaining].join(','))
}

// Trigger: leads need a RUNNING parent scan_job.
const OVERRIDES: Record<string, Record<string, string>> = { scan_jobs: { status: 'running' }, leads: { company: 'acme-co' } }

const db = new Database(SRC)
const parentKeys: Record<string, any[]> = {}
const valueFor = (t: string, c: Col, i: number): any => {
  const ov = OVERRIDES[t]?.[c.name]; if (ov !== undefined) return ov
  const fk = (fks[t] || []).find(f => f.col === c.name)
  if (fk) {
    const parents = parentKeys[fk.ref]
    if (parents?.length) return parents[i % parents.length]
    return `orphan-${i}` // nullable FK without parent rows (SET NULL style)
  }
  if (c.int) return c.intMin !== undefined && c.intMax !== undefined ? c.intMin + (i % (c.intMax - c.intMin + 1)) : i + 1
  if (c.inList?.length) return c.inList[0]
  let v = c.like ? `${c.like}x${i}` : `${t.slice(0, 8)}-${c.name.slice(0, 8)}-${i}`
  if (c.exactLen) v = (v + 'x'.repeat(c.exactLen)).slice(0, c.exactLen)
  else if (c.maxLen && v.length > c.maxLen) v = v.slice(0, c.maxLen)
  if (c.minLen && v.length < c.minLen) v = v + 'x'.repeat(c.minLen - v.length)
  return v
}

let inserted = 0
const insert = db.transaction(() => {
  for (const t of order) {
    const cs = cols[t]
    const targets = cs.filter(c => c.pk || (c.notnull && !c.dflt) || OVERRIDES[t]?.[c.name] !== undefined)
    for (let i = 0; i < ROWS; i++) {
      const row: Record<string, any> = {}
      for (const c of targets) row[c.name] = valueFor(t, c, i)
      const names = Object.keys(row)
      try {
        db.prepare(`INSERT INTO ${t} (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(...names.map(n => row[n]))
      } catch (e) { console.error(`insert fail ${t} row=${JSON.stringify(row)}`); throw e }
      inserted++
      if (i === 0) {
        const pkCol = cs.find(c => c.pk)
        if (pkCol) (parentKeys[t] ||= []).push(row[pkCol.name])
      }
    }
    // capture more parent keys if composite/multi needed
    const pkCol = cs.find(c => c.pk)
    if (pkCol) parentKeys[t] = db.prepare(`SELECT ${pkCol.name} AS k FROM ${t}`).all().map((r: any) => r.k)
  }
})
insert()
console.log(`sqlite populated: ${inserted} rows across ${order.length} tables`)

// Write-path guard rehearsal: freeze source read-only, prove writes fail.
db.close()
const frozen = new Database(SRC, { readonly: true })
let guardOk = false
try { frozen.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location) VALUES ('X','u','b','i','l')").run() }
catch (e: any) { guardOk = /readonly|attempt to write/i.test(String(e?.message)) }
console.log(`write-guard: source frozen, write attempt ${guardOk ? 'REJECTED as expected' : 'WAS NOT REJECTED - GUARD FAILURE'}`)
if (!guardOk) process.exit(1)

// Copy every table to PG, then verify counts + full-content equality.
const client = new pg.Client({ connectionString: PG_URL })
await client.connect()
await client.query(`TRUNCATE ${order.join(', ')} CASCADE`)
const divergences: string[] = []
for (const t of order) {
  const rows = frozen.prepare(`SELECT * FROM ${t}`).all() as Record<string, any>[]
  const names = rows.length ? Object.keys(rows[0]) : cols[t].map(c => c.name)
  for (const r of rows) {
    await client.query(`INSERT INTO ${t} (${names.join(',')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(',')})`, names.map(n => r[n]))
  }
  const pgCount = Number((await client.query(`SELECT count(*) AS c FROM ${t}`)).rows[0].c)
  if (pgCount !== rows.length) { divergences.push(`${t}: count sqlite=${rows.length} pg=${pgCount}`); continue }
  const liteDump = rows.map(r => JSON.stringify(names.map(n => r[n] === null || r[n] === undefined ? null : String(r[n])))).sort()
  const pgRows = (await client.query(`SELECT ${names.map(n => `"${n}"::text`).join(',')} FROM ${t}`)).rows as Record<string, string | null>[]
  const pgDump = pgRows.map(r => JSON.stringify(names.map(n => r[n] ?? null))).sort()
  for (let i = 0; i < liteDump.length; i++) if (liteDump[i] !== pgDump[i]) { divergences.push(`${t}: content mismatch: ${liteDump[i]} vs ${pgDump[i]}`); break }
}
frozen.close()

// Trigger behavior equivalence: every guard trigger must abort its illegal op.
const expectAbort = async (label: string, sql: string, msg: string) => {
  try { await client.query(sql); divergences.push(`trigger ${label}: illegal op was ALLOWED`) }
  catch (e: any) { if (!String(e?.message).includes(msg)) divergences.push(`trigger ${label}: wrong error: ${e?.message}`) }
}
await client.query("INSERT INTO scan_jobs (id, user_id, business_name, industry, location) VALUES ('TG1','u','b','i','l')")
await expectAbort('leads_only_while_running',
  "INSERT INTO leads (id, scan_job_id, company, signal, source_url) VALUES ('TGL1','TG1','c','sig here','https://x.co')",
  'leads can only be added to a running job')
await expectAbort('scan_jobs_transitions',
  "UPDATE scan_jobs SET status='done' WHERE id='TG1'", 'illegal scan job status transition')
await client.query("UPDATE scan_jobs SET status='running' WHERE id='TG1'")
await client.query("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status) VALUES ('TGO1','t','l','a@b.co','subj','a sufficiently long body for checks','sent')")
await expectAbort('outreach_sent_is_final',
  "UPDATE outreach_messages SET status='draft' WHERE id='TGO1'", 'final outreach status')
await client.query("INSERT INTO sequence_steps (tenant_id, sequence_id, step, subject, body, status) VALUES ('t','s',3,'subj','body','sent')")
await expectAbort('sequence_sent_final',
  "UPDATE sequence_steps SET body='changed' WHERE tenant_id='t' AND sequence_id='s' AND step=3", 'sent sequence step is final')
await client.query("DELETE FROM leads WHERE id='TGL1'").catch(() => {})
await client.query("DELETE FROM outreach_messages WHERE id='TGO1'").catch(() => {})
await client.query("DELETE FROM sequence_steps WHERE tenant_id='t' AND sequence_id='s'").catch(() => {})
await client.query("DELETE FROM scan_jobs WHERE id='TG1'").catch(() => {})
console.log('trigger behavior: 4 guard triggers verified on PG')
await client.end()
console.log(`divergences: ${divergences.length}`)
for (const d of divergences.slice(0, 10)) console.log('  ' + d)
if (divergences.length) process.exit(1)
console.log(`FULL REHEARSAL CLEAN: ${order.length} tables, all rows copied losslessly under frozen writes (synthetic data)`)
