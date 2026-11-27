import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { addEnrichment } from '../lib/connectors/store.ts'
import { sqliteDb, type Db, type Tx } from '../lib/db/client.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { createJob } from '../lib/scan/store.ts'
import * as timing from '../lib/scan/timing-proof.ts'

test('timing proof batch matches scalar decisions with constant reads and job/tenant isolation', async t => {
  const db = new Database(':memory:')
  t.after(() => db.close())
  migrateAllSqlite(db)
  const now = new Date('2026-11-27T12:00:00Z')
  const create = (tenant: string) => {
    const id = createJob(db, tenant, { business_name: 'Seller', industry: 'supplies', location: 'Toronto' })
    db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify({ window_days: 30 }), id)
    return { id, user_id: tenant }
  }
  const job = create('own')
  const otherJob = create('own')
  const otherTenant = create('foreign')
  const addLead = (owner: typeof job, id: string) => {
    db.prepare(`INSERT INTO leads (id, scan_job_id, company, signal, source_url, confidence, score,
      signal_kind, event_date, event_date_proof, company_domain)
      VALUES (?, ?, 'Example Buyer', 'Opened a new facility', 'https://buyer.example/news', 80, 70,
        'expansion', '2026-11-25', 'page_bound', 'buyer.example')`).run(id, owner.id)
    const add = (connector: string, kind: string, value: string, label: string | null = null) =>
      addEnrichment(db, owner.user_id, id, { connector, kind, value, label, confidence: null,
        source_url: 'https://buyer.example/team', source_date: '2026-11-25', retrieved_at: now.getTime() / 1000 })
    add('sitecrawl', 'domain', 'buyer.example|evidence_own_domain', 'domain-basis-v1:evidence_own_domain')
    add('sitecrawl', 'person', 'Dana Lee, Owner')
    add('sitecrawl', 'email', 'dana@buyer.example')
    add('scan:actionable', 'actionability', 'Actionable: confirmed', 'Dana Lee, Owner - email: dana@buyer.example')
  }
  const ids = Array.from({ length: 40 }, (_, i) => `lead-${i}`)
  for (const id of ids) addLead(job, id)
  addLead(otherJob, 'other-job')
  addLead(otherTenant, 'other-tenant')
  assert.deepEqual(timing.recordTimingProof(db, job, now), { proven: 40, held: 0 })
  db.prepare('DELETE FROM lead_enrichments WHERE lead_id = ? AND connector = ?').run(ids[1], timing.TIMING_PROOF_CONNECTOR)
  db.prepare('UPDATE lead_enrichments SET value = ? WHERE lead_id = ? AND connector = ?')
    .run('{bad', ids[2], timing.TIMING_PROOF_CONNECTOR)

  const expected = (requested: string[]) => new Map(requested.map(id => [
    id, ids.includes(id) ? timing.timingProofGap(db, job.user_id, id, now) : 'no_lead',
  ]))
  assert.deepEqual([...expected(ids.slice(0, 3)).values()], [null, 'no_record', 'binding_changed'])
  const store = sqliteDb(db)
  const evidenceError = new Error('timing evidence unavailable')
  let failEvidence = false
  let reads = 0
  let snapshots = 0
  const count = (sql: string) => {
    reads++
    if (failEvidence && sql.includes('lead_enrichments')) throw evidenceError
  }
  const counted: Db = {
    ...store,
    all: (sql, params) => { count(sql); return store.all(sql, params) },
    tx: (body, isolation) => {
      assert.equal(isolation, 'serializable')
      snapshots++
      return store.tx(function* (tx) {
        const countedTx: Tx = {
          ...tx,
          all: (sql, params) => { count(sql); return tx.all(sql, params) },
        }
        return yield* body(countedTx)
      }, isolation)
    },
    get: (sql, params) => { count(sql); return store.get(sql, params) },
  }
  failEvidence = true
  await assert.rejects(timing.timingProofGapsDb(counted, job.user_id, job.id, ids, now), error => error === evidenceError)
  failEvidence = false
  for (const n of [20, 40]) {
    reads = 0
    snapshots = 0
    const requested = [...ids.slice(0, n), 'other-job', 'other-tenant', 'absent']
    assert.deepEqual(await timing.timingProofGapsDb(counted, job.user_id, job.id, requested, now), expected(requested))
    assert.equal(snapshots, 1, 'both reads use one serializable snapshot')
    assert.equal(reads, 2, 'one lead read and one evidence read regardless of batch size')
  }
  reads = 0
  assert.deepEqual(await timing.timingProofGapsDb(counted, 'foreign', job.id, ids, now), new Map(ids.map(id => [id, 'no_lead'])))
  assert.equal(reads, 1)
})
