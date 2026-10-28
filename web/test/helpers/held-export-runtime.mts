import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateScan, createJob } from '../../lib/scan/store.ts'
import { migrateConnectors } from '../../lib/connectors/store.ts'
import { GET as exportGET } from '../../app/api/leads/export/route.ts'

// The REAL CSV export route (it reads through store-db.ts, on SQLite too). A lead the required sales gate failed on whose review write was rejected still has review_reason NULL and
// a confidence in its stored row; the gate_failed marker beside it must make the export show it as held. In-memory DB, no network.
globalThis.fetch = (async () => { throw new Error('Unexpected network call') }) as typeof fetch
const hex = () => randomBytes(12).toString('hex')
const get = (p: string) => new NextRequest(`http://localhost${p}`, { method: 'GET' })
function parseCsv(csv: string): Record<string, string>[] {
  const rows: string[][] = []; let cur: string[] = [], f = '', q = false
  for (let i = 0; i < csv.length; i++) { const c = csv[i]
    if (q) { if (c === '"' && csv[i + 1] === '"') { f += '"'; i++ } else if (c === '"') q = false; else f += c }
    else if (c === '"') q = true; else if (c === ',') { cur.push(f); f = '' } else if (c === '\n') { cur.push(f); rows.push(cur); cur = []; f = '' } else if (c !== '\r') f += c }
  if (f || cur.length) { cur.push(f); rows.push(cur) }
  const [h, ...rest] = rows; return rest.map(r => Object.fromEntries(h.map((k, i) => [k, r[i] ?? ''])))
}
test('export route: a failed-gate lead exports as sales_hiring_check_failed with no confidence; a landed control still exports verified', async () => {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db); setScanDb(db)
  const job = createJob(db, 'A', { business_name: 'Acme', industry: 'x', location: 'y' }); db.prepare("UPDATE scan_jobs SET status='running', attempts=1 WHERE id=?").run(job)
  const ins = db.prepare('INSERT INTO leads(id,scan_job_id,company,signal,source_url,confidence,review_reason,score) VALUES (?,?,?,?,?,?,?,?)')
  const ids = { held: hex(), ok: hex(), review: hex() }
  ins.run(ids.held, job, 'HeldCo', 's', 'https://news.example/h', 55, null, 60)
  ins.run(ids.ok, job, 'LandedCo', 's', 'https://news.example/o', 70, null, 70)
  ins.run(ids.review, job, 'ReviewCo', 's', 'https://news.example/r', null, 'quote_unconfirmed', 50)
  db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES (?, ?, 'A', 'scan:gate', 'gate_failed', 'sales_hiring_check_failed', 'x', NULL, 'https://invalid.example/', '2026-10-28', 1)").run(hex(), ids.held)
  setUser({ id: 'A', business_name: 'Acme' })
  const res = await exportGET(get(`/api/leads/export?job_id=${job}`)); assert.equal(res.status, 200)
  const rows = parseCsv(await res.text()); const by = (c: string) => rows.find(r => r['Company'] === c)!
  assert.deepEqual([by('HeldCo')['Review Reason'], by('HeldCo')['Confidence']], ['sales_hiring_check_failed', ''], 'the failed-gate lead is held in the export, with no confidence')
  assert.deepEqual([by('LandedCo')['Review Reason'], by('LandedCo')['Confidence']], ['', '70'], 'a lead whose write landed (no marker) still exports verified')
  assert.deepEqual([by('ReviewCo')['Review Reason'], by('ReviewCo')['Confidence']], ['quote_unconfirmed', ''], 'an ordinary review lead is unchanged')
})
