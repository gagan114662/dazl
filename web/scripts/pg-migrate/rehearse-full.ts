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
// Guarded target: an admin loopback URL is used to PROVISION a fresh, dedicated
// dazl_rehearse_* database + non-superuser role; the copy itself runs as that
// role. No path to an arbitrary target exists.
const PG_ADMIN = process.env.DAZL_PG_ADMIN
const ROWS = Number(process.env.REHEARSE_ROWS || 3)
if (!PG_ADMIN) { console.error('set DAZL_PG_ADMIN (loopback maintenance URL)'); process.exit(2) }

rmSync(SRC, { force: true }); rmSync(`${SRC}-wal`, { force: true }); rmSync(`${SRC}-shm`, { force: true })
copyFileSync(SRC_TEMPLATE, SRC)
const ddl = readFileSync(process.env.SQLITE_SCHEMA || '/tmp/full-schema.sql', 'utf8')

// Parse each table's column defs: name, type, notnull, dflt, pk + inline CHECK IN / LIKE.
const tables = [...ddl.matchAll(/CREATE TABLE (\w+) \(([\s\S]*?)\);/g)].map(m => ({ name: m[1], body: m[2] }))
type Col = { name: string; int: boolean; uniq: boolean; notnull: boolean; dflt: boolean; pk: boolean; inList?: string[]; like?: string; exactLen?: number; maxLen?: number; minLen?: number; intMin?: number; intMax?: number }
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
    const ibM = restS.match(/(?<!length\(\w+\) )\bBETWEEN (\d+) AND (\d+)/i)
    const likeM = restS.match(/LIKE '([^']+)'/i)
    const refM = restS.match(/REFERENCES (\w+)/i)
    if (refM) (fks[t.name] ||= []).push({ col: name, ref: refM[1] })
    list.push({
      name, int: colType.toUpperCase() !== 'TEXT', uniq: /\bUNIQUE\b/i.test(restS),
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
  // composite PK + table-level UNIQUE constraints
  const pkM = t.body.match(/PRIMARY KEY \(([^)]*)\)/i)
  if (pkM) for (const n of pkM[1].split(',').map(s => s.trim())) {
    const c = list.find(c => c.name === n); if (c) c.pk = true
  }
  for (const uq of t.body.matchAll(/UNIQUE \(([^)]*)\)/gi)) {
    for (const n of uq[1].split(',').map(s => s.trim())) {
      const c = list.find(c => c.name === n); if (c) c.uniq = true
    }
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
const OVERRIDES: Record<string, Record<string, string>> = { scan_jobs: { status: 'running' } }

// Dense value generation: every column populated with a deterministic mix of
// NULLs (nullable only), unicode, boundary-length text, and int-range extremes.
const UNICODE = 'héllo wörld ünïcode ☃ 日本語'
const denseText = (c: Col, i: number, ci: number): string => {
  const kind = (i + ci) % 3
  let v = kind === 2 ? `${UNICODE} ${i}` : `${t8(c)}-${i}`
  function t8(c: Col) { return c.name.slice(0, 8) }
  if (kind === 1 && (c.maxLen || c.exactLen)) v = 'm'.repeat((c.maxLen || c.exactLen)!) // boundary: exactly max
  if (c.exactLen) v = (v + 'x'.repeat(c.exactLen)).slice(0, c.exactLen)
  else if (c.maxLen && v.length > c.maxLen) v = v.slice(0, c.maxLen)
  if (c.minLen && v.length < c.minLen) v = v + 'x'.repeat(c.minLen - v.length)
  if (v === '') v = 'x' // CHECK (name <> '' ...) style guards
  return v
}

const db = new Database(SRC)
const parentKeys: Record<string, any[]> = {}
const valueFor = (t: string, c: Col, i: number, ci: number): any => {
  const ov = OVERRIDES[t]?.[c.name]; if (ov !== undefined) return ov
  const fk = (fks[t] || []).find(f => f.col === c.name)
  if (fk) {
    const parents = parentKeys[fk.ref]
    if (parents?.length) return parents[i % parents.length]
    if (!c.notnull && i % 4 === 0) return null // nullable FK: exercise the NULL mix
    return `orphan-${i}` // nullable FK without parent rows (SET NULL style)
  }
  if (!c.notnull && !c.pk && i % 4 === 0) return null // NULL mix on nullable columns
  if (c.int) {
    if (c.intMin !== undefined && c.intMax !== undefined) {
      const span = c.intMax - c.intMin + 1
      return c.intMin + ((i + ci) % span) // boundary extremes included
    }
    return [0, i + 1, 1_792_701_186 + i][(i + ci) % 3] // zero / small / epoch-scale
  }
  if (c.inList?.length) return c.inList[(i + ci) % c.inList.length] // CHECK IN wins; other cols carry uniqueness
  if (c.like) return `${c.like}${t.slice(0, 6)}-${c.name.slice(0, 6)}-${i}`
  if (c.pk || c.uniq) return `${t.slice(0, 6)}-${c.name.slice(0, 6)}-${i}` // uniqueness-safe
  return denseText(c, i, ci)
}

let inserted = 0
const insert = db.transaction(() => {
  for (const t of order) {
    const cs = cols[t]
    const targets = cs // dense pass: ALL columns populated (NULL mix handled in valueFor)
    for (let i = 0; i < ROWS; i++) {
      const row: Record<string, any> = {}
      let ci = 0
      for (const c of targets) row[c.name] = valueFor(t, c, i, ci++)
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

// Provision a fresh, dedicated, guarded rehearsal target and apply the
// guarded generated schema (the file itself refuses non-rehearsal databases).
const { provisionRehearsalDb, assertRehearsalTarget, dropRehearsalDb } = await import('./guard.ts')
const rolePassword = 'rhz-' + Math.random().toString(36).slice(2)
const prov = await provisionRehearsalDb(PG_ADMIN, rolePassword)
console.log(`provisioned guarded target: ${prov.dbName} (loopback, per-run role ${prov.role}, marker verified)`)
const client = new pg.Client({ connectionString: prov.url })
await client.connect()
await assertRehearsalTarget(client, prov.token)
await client.query(readFileSync(process.env.PG_SCHEMA || '/tmp/full-schema-pg.sql', 'utf8'))
await assertRehearsalTarget(client, prov.token)
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

// Edge battery: multi-row atomicity, transaction rollback, missing parent.
await client.query("INSERT INTO scan_jobs (id, user_id, business_name, industry, location) VALUES ('MR1','u','b','i','l'),('MR2','u','b','i','l'),('MR3','u','b','i','l')")
try {
  await client.query("UPDATE scan_jobs SET status='done' WHERE id IN ('MR1','MR2','MR3')")
  divergences.push('multi-row: illegal bulk update was ALLOWED')
} catch (e: any) {
  if (!String(e?.message).includes('illegal scan job status transition')) divergences.push('multi-row: wrong error: ' + e?.message)
}
const pendingAfter = Number((await client.query("SELECT count(*) AS c FROM scan_jobs WHERE id IN ('MR1','MR2','MR3') AND status='pending'")).rows[0].c)
if (pendingAfter !== 3) divergences.push(`multi-row: aborted statement was not atomic (${3 - pendingAfter} rows changed)`)
await client.query('BEGIN')
try {
  await client.query("INSERT INTO scan_jobs (id, user_id, business_name, industry, location) VALUES ('RB1','u','b','i','l')")
  await client.query("UPDATE scan_jobs SET status='done' WHERE id='RB1'")
  divergences.push('rollback: illegal update inside transaction was ALLOWED')
  await client.query('ROLLBACK')
} catch {
  await client.query('ROLLBACK')
}
const rbSurvives = Number((await client.query("SELECT count(*) AS c FROM scan_jobs WHERE id='RB1'")).rows[0].c)
if (rbSurvives !== 0) divergences.push('rollback: row survived ROLLBACK after trigger error')
await expectAbort('missing-parent lead',
  "INSERT INTO leads (id, scan_job_id, company, signal, source_url) VALUES ('MPL1','NO_SUCH_JOB','c','sig','https://x.co')",
  'leads can only be added to a running job')
await client.query("DELETE FROM scan_jobs WHERE id IN ('MR1','MR2','MR3')")
console.log('trigger edge battery: multi-row atomicity, rollback, missing-parent verified')
await client.end()
console.log(`divergences: ${divergences.length}`)
for (const d of divergences.slice(0, 10)) console.log('  ' + d)
if (divergences.length) process.exit(1)
await dropRehearsalDb(PG_ADMIN, prov.dbName, prov.role)
console.log(`rehearsal target ${prov.dbName} dropped`)
console.log(`FULL REHEARSAL CLEAN: ${order.length} tables, all rows copied losslessly under frozen writes (synthetic data)`)
