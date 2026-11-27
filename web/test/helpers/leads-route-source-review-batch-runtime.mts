import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { GET } from '../../app/api/leads/route.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { setScanDb, setUser } from './tenant-route-db.ts'

test('Leads returns one latest review projection per owned lead in a bounded batch', async t => {
  const db = new Database(':memory:')
  t.after(() => db.close())
  migrateAllSqlite(db)
  const owned = 'a'.repeat(24)
  const foreign = 'b'.repeat(24)
  const source = 'https://example.test/review'
  const insertJob = db.prepare(`INSERT INTO scan_jobs
    (id, user_id, business_name, industry, location, query, status, candidates, created_at)
    VALUES (?, ?, 'Fixture', 'services', '-', 'Find businesses', 'running', 40, 1000)`)
  insertJob.run(owned, 'owner')
  insertJob.run(foreign, 'foreign')
  const insertLead = db.prepare(`INSERT INTO leads (id, scan_job_id, company, signal, source_url)
    VALUES (?, ?, 'Fixture', 'Expansion', ?)`)
  insertLead.run('reviewed', owned, source)
  insertLead.run('unreviewed', owned, source)
  insertLead.run('foreign-lead', foreign, source)

  const insertReview = db.prepare(`INSERT INTO source_reviews (id, tenant_id, job_id, lead_id,
    input_json, fetch_status, quote_match, company_named, contact_match, checked_at)
    VALUES (?, ?, ?, ?, ?, 'fetched', ?, 1, ?, ?)`)
  for (const [id, tenant, job, lead, quote, time] of [
    ['older', 'owner', owned, 'reviewed', 0, 10],
    ['tie-a', 'owner', owned, 'reviewed', 0, 20],
    ['tie-z', 'owner', owned, 'reviewed', 1, 20],
    ['wrong-tenant', 'foreign', owned, 'reviewed', 0, 30],
    ['wrong-job', 'owner', foreign, 'reviewed', 0, 40],
    ['foreign-review', 'foreign', foreign, 'foreign-lead', 1, 50],
  ] as const) {
    const input = JSON.stringify({ contact_context: { excerpt: id, source_url: source } })
    insertReview.run(id, tenant, job, lead, input, quote, quote, time)
  }

  let reads = 0
  setScanDb(new Proxy(db, {
    get(target, key) {
      if (key === 'prepare') return (sql: string) => {
        if (/\bFROM source_reviews\b/i.test(sql)) reads++
        return target.prepare(sql)
      }
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }))
  setUser({ id: 'owner', business_name: 'Owner' })
  const request = (id: string) => GET(new NextRequest(`http://test/api/leads?job_id=${id}`))
  const read = async () => {
    reads = 0
    const response = await request(owned)
    assert.equal(response.status, 200)
    const body: { leads: { id: string; source_check: unknown; contact_context: unknown }[] } = await response.json()
    return { leads: new Map(body.leads.map(row => [row.id, row])), reads }
  }
  const small = await read()
  for (let i = 0; i < 38; i++) insertLead.run(`lead-${i}`, owned, source)
  const large = await read()

  assert.equal(large.leads.size, 40)
  for (const { leads } of [small, large]) {
    assert.deepEqual(leads.get('reviewed')?.source_check, {
      fetch_status: 'fetched', quote_match: true, company_named: true, contact_match: true, checked_at: 20,
    })
    assert.deepEqual(leads.get('reviewed')?.contact_context, { excerpt: 'tie-z', source_url: source })
    assert.equal(leads.get('unreviewed')?.source_check, null)
    assert.equal(leads.get('unreviewed')?.contact_context, null)
    assert.ok(!leads.has('foreign-lead'))
  }
  assert.equal((await request(foreign)).status, 404)
  assert.equal(large.reads, small.reads, 'source-review reads must remain bounded as the page grows')
  assert.equal(large.reads, 1, 'both response fields share one source-review read')
})
