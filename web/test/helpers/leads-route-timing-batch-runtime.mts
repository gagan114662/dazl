import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { addEnrichment } from '../../lib/connectors/store.ts'
import { GET } from '../../app/api/leads/route.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { recordTimingProof, timingProofGap } from '../../lib/scan/timing-proof.ts'
import { currentnessHeld, leadWindowHeld } from '../../lib/outreach/currentness.ts'
import { setScanDb, setUser } from './tenant-route-db.ts'

test('Leads timing projection preserves scalar outcomes and bounds timing reads', async (t) => {
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
  db.prepare("UPDATE scan_jobs SET icp = ? WHERE id = ?").run(JSON.stringify({ window_days: 45 }), owned)
  const now = new Date()
  const day = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10)
  db.prepare(`UPDATE leads SET event_date = ?, confidence = 80, event_date_proof = 'page_bound',
    signal = 'Opened a new facility', signal_kind = 'expansion', company_domain = 'buyer.example',
    source_url = 'https://buyer.example/news' WHERE id = 'clear'`).run(day)
  const addProofEvidence = (connector: string, kind: string, value: string, label: string | null = null) =>
    addEnrichment(db, 'owner', 'clear', { connector, kind, value, label, confidence: null,
      source_url: 'https://buyer.example/team', source_date: day, retrieved_at: Math.floor(now.getTime() / 1000) })
  addProofEvidence('sitecrawl', 'domain', 'buyer.example|evidence_own_domain', 'domain-basis-v1:evidence_own_domain')
  addProofEvidence('sitecrawl', 'person', 'Dana Lee, Owner')
  addProofEvidence('sitecrawl', 'email', 'dana@buyer.example')
  addProofEvidence('scan:actionable', 'actionability', 'Actionable: confirmed', 'Dana Lee, Owner - email: dana@buyer.example')
  assert.deepEqual(recordTimingProof(db, { id: owned, user_id: 'owner' }, now), { proven: 1, held: 0 })
  let timingReads = 0
  let evidenceReads = 0
  const observed = new Proxy(db, {
    get(target, key) {
      if (key === 'prepare') return (sql: string) => {
        if (/SELECT (?:l\.source_kind,l\.human_confirmed_at|l\.event_date,j\.icp|l\.id, l\.(?:source_url, l\.company_domain, l\.event_date, l\.event_date_proof|contact, l\.source_url, l\.company_domain, l\.event_date, l\.event_date_proof)|l\.id, l\.source_kind, l\.human_confirmed_at)/.test(sql)) timingReads++
        if (sql.includes('SELECT e.lead_id, e.connector, e.kind, e.value, e.label, e.source_url, e.retrieved_at')) evidenceReads++
        return target.prepare(sql)
      }
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  setScanDb(observed)
  setUser({ id: 'owner', business_name: 'Owner' })
  const request = (jobId: string) => GET(new NextRequest(`http://test/api/leads?job_id=${jobId}&all=1`))
  const projection = async (expectedCount: number) => {
    timingReads = 0
    evidenceReads = 0
    const response = await request(owned)
    assert.equal(response.status, 200)
    const body: { leads: { id: string; timing_proof_gap: string | null; window_held: boolean; currentness_held: boolean }[] } = await response.json()
    assert.equal(body.leads.length, expectedCount)
    assert.ok(body.leads.some(row => row.window_held))
    assert.ok(body.leads.some(row => !row.window_held))
    const proven = body.leads.find(row => row.id === 'clear')
    assert.ok(proven)
    assert.equal(proven.timing_proof_gap, null, 'durable proof reaches the route as proven')
    assert.equal(proven.currentness_held, false)
    for (const row of body.leads) {
      assert.notEqual(row.id, 'other')
      assert.equal(row.timing_proof_gap, timingProofGap(db, 'owner', row.id))
      assert.equal(row.window_held, leadWindowHeld(db, 'owner', row.id))
      assert.equal(row.currentness_held, currentnessHeld(db, 'owner', row.id))
    }
    assert.equal(evidenceReads, 1, 'eligible route results read timing evidence once')
    return timingReads
  }
  assert.equal((await request(foreign)).status, 404)
  for (let i = 0; i < 18; i++) insertLead.run(`extra-${i}`, owned, `Extra ${i}`)
  const small = await projection(20)
  for (let i = 18; i < 38; i++) insertLead.run(`extra-${i}`, owned, `Extra ${i}`)
  const large = await projection(40)
  assert.equal(small, 2, 'one scoped currentness read and one timing-proof lead read')
  assert.equal(large, small, 'timing row reads must stay constant as the page grows')
})
