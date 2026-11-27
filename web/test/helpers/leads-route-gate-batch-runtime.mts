import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { GET } from '../../app/api/leads/route.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { requiredGateHeld } from '../../lib/scan/held-state.ts'
import { setScanDb, setUser } from './tenant-route-db.ts'

test('Leads gate projection preserves scalar outcomes and bounds marker reads', async (t) => {
  const db = new Database(':memory:')
  t.after(() => db.close())
  migrateAllSqlite(db)
  const owned = 'a'.repeat(24)
  const foreign = 'b'.repeat(24)
  const insertJob = db.prepare(`INSERT INTO scan_jobs
    (id, user_id, business_name, industry, location, query, status, candidates, created_at)
    VALUES (?, ?, 'workspace', 'services', '-', 'Find businesses', 'running', 20, 1000)`)
  insertJob.run(owned, 'owner')
  insertJob.run(foreign, 'foreign')
  const insertLead = db.prepare(`INSERT INTO leads (id, scan_job_id, company, signal, source_url)
    VALUES (?, ?, ?, 'Expansion', 'https://example.test/source')`)
  insertLead.run('held', owned, 'Held')
  insertLead.run('clear', owned, 'Clear')
  insertLead.run('other', foreign, 'Foreign')
  const mark = db.prepare(`INSERT INTO lead_enrichments
    (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at)
    VALUES (?, ?, ?, 'scan:gate', 'gate_failed', 'required', 'gate', 1, 'https://example.test/source', '2026-01-01', 1)`)
  mark.run('held-marker', 'held', 'owner')
  mark.run('other-marker', 'other', 'foreign')
  mark.run('wrong-tenant-marker', 'clear', 'foreign')

  let markerReads = 0
  let unreadable = false
  const observed = new Proxy(db, {
    get(target, key) {
      if (key === 'prepare') return (sql: string) => {
        if (sql.includes('scan:gate') && /^SELECT (?:1 FROM lead_enrichments|value FROM lead_enrichments|e\.lead_id, e\.kind, e\.value)\b/i.test(sql.trim())) {
          markerReads++
          if (unreadable) throw new Error('SQLITE_IOERR: gate markers unreadable')
        }
        return target.prepare(sql)
      }
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  setScanDb(observed)
  setUser({ id: 'owner', business_name: 'Owner' })
  const request = (jobId: string) => GET(new NextRequest(`http://test/api/leads?job_id=${jobId}&all=1`))
  const projection = async () => {
    markerReads = 0
    const response = await request(owned)
    assert.equal(response.status, 200)
    const body: { leads: { id: string; gate_held: boolean }[] } = await response.json()
    return { holds: Object.fromEntries(body.leads.map(row => [row.id, row.gate_held])), reads: markerReads }
  }
  const mixed = await projection()
  assert.deepEqual(mixed.holds, { held: true, clear: false })
  for (const [id, held] of Object.entries(mixed.holds)) {
    assert.equal(held, requiredGateHeld(db, 'owner', id) !== null)
  }
  assert.equal((await request(foreign)).status, 404)

  for (let i = 0; i < 18; i++) insertLead.run(`extra-${i}`, owned, `Extra ${i}`)
  const larger = await projection()
  assert.equal(Object.keys(larger.holds).length, 20)
  unreadable = true
  const failed = await projection()
  assert.equal(Object.keys(failed.holds).length, 20)
  assert.ok(Object.values(failed.holds).every(Boolean), 'unreadable markers hold every affected lead')

  assert.equal(larger.reads, mixed.reads, 'gate marker reads must stay constant as the list grows')
  assert.ok(larger.reads <= 2, 'normal request uses a bounded number of gate marker reads')
})
