import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateScan, createJob } from '../../lib/scan/store.ts'
import { migrateConnectors } from '../../lib/connectors/store.ts'
import { GET as exportGET } from '../../app/api/leads/export/route.ts'

// #384 on the REAL CSV export route: provenance, deliverability and person-route are separate columns; a generic inbox is never the Best Person's route; "printed on the page" is never "deliverable".
globalThis.fetch = (async () => { throw new Error('Unexpected network call') }) as typeof fetch
const hex = () => randomBytes(12).toString('hex')
function parseCsv(csv: string): Record<string, string>[] {
  const rows: string[][] = []; let cur: string[] = [], f = '', q = false
  for (let i = 0; i < csv.length; i++) { const c = csv[i]
    if (q) { if (c === '"' && csv[i + 1] === '"') { f += '"'; i++ } else if (c === '"') q = false; else f += c }
    else if (c === '"') q = true; else if (c === ',') { cur.push(f); f = '' } else if (c === '\n') { cur.push(f); rows.push(cur); cur = []; f = '' } else if (c !== '\r') f += c }
  if (f || cur.length) { cur.push(f); rows.push(cur) }
  const [h, ...rest] = rows; return rest.map(r => Object.fromEntries(h.map((k, i) => [k, r[i] ?? ''])))
}
test('export: hello@ beside a named Best Person is a company inbox, not their route; the person\'s own address is a person route; neither is "deliverable" just because it was printed on a page', async () => {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db); setScanDb(db)
  const job = createJob(db, 'A', { business_name: 'Acme', industry: 'x', location: 'y' }); db.prepare("UPDATE scan_jobs SET status='running', attempts=1 WHERE id=?").run(job)
  const ins = db.prepare('INSERT INTO leads(id,scan_job_id,company,signal,source_url,evidence_excerpt,confidence,review_reason,score,contact) VALUES (?,?,?,?,?,?,?,?,?,?)')
  const generic = hex(), own = hex()
  ins.run(generic, job, 'GenericCo', 's', 'https://news.example/g', 'GenericCo opened hello@generic.example', 70, null, 70, 'hello@generic.example')
  ins.run(own, job, 'OwnCo', 's', 'https://news.example/o', 'Reach Dana Lee at dana.lee@own.example', 70, null, 70, 'dana.lee@own.example')
  const enr = db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES (?, ?, 'A', 'sitecrawl', 'person', 'Dana Lee, Practice Owner', 'x', NULL, 'https://x.example/team', '2026-10-28', 1)")
  enr.run(hex(), generic); enr.run(hex(), own)
  setUser({ id: 'A', business_name: 'Acme' })
  const res = await exportGET(new NextRequest(`http://localhost/api/leads/export?job_id=${job}`, { method: 'GET' })); assert.equal(res.status, 200)
  const rows = parseCsv(await res.text()); const by = (c: string) => rows.find(r => r['Company'] === c)!
  const g = by('GenericCo'), o = by('OwnCo')
  assert.match(g['Best Person (research candidate, not verified as current)'], /Dana Lee/)
  assert.match(g['Contact Route (person = tied to the Best Person; company inbox = NOT the decision-maker)'], /^company inbox: .*not tied to Dana Lee/)
  assert.match(o['Contact Route (person = tied to the Best Person; company inbox = NOT the decision-maker)'], /^person:/)
  for (const r of [g, o]) {
    assert.equal(r['Contact Published (where the address was printed; not a deliverability check)'], 'printed on the cited page')
    assert.equal(r['Contact Deliverability (unknown unless a mailbox check was run)'], 'deliverability not checked'); assert.doesNotMatch(r['Contact Deliverability (unknown unless a mailbox check was run)'], /deliverable$|valid|passed/)
  }
})
