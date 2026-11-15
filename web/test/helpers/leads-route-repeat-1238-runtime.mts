// #1238 route seam: GET /api/leads (real handler, stubbed session, no network) says how many READY leads are repeats of an earlier scan
// (repeat_count), from the rows it already read, so the page, the API and the matrix agree on what the user is shown.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { GET as leadsGET } from '../../app/api/leads/route.ts'

globalThis.fetch = (async () => { throw new Error('Unexpected network call') }) as typeof fetch

test('#1238 GET /api/leads: repeat_count counts ready repeats only (a held repeat and a fresh ready lead are not counted)', async () => {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  setScanDb(db); setUser({ id: 'A', business_name: 'Acme' })
  const job = 'b'.repeat(24)
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, status, candidates, created_at) VALUES (?, 'A', 'x', '(from request)', '-', 'Law firms in Chicago that opened a new office', 'running', 4, 1000)").run(job)
  const add = (id: string, review: string | null, seen: number) => db.prepare("INSERT INTO leads (id, scan_job_id, company, signal, source_url, confidence, evidence_excerpt, review_reason, fit, seen_before) VALUES (?, ?, ?, 'opened an office', 'https://news.example/a', 80, 'q', ?, 4, ?)")
    .run(id, job, `Co ${id}`, review, seen)
  add('zayed', null, 1); add('dechert', null, 1); add('armstrong', 'outside_window_undated', 1); add('ogletree', null, 0)
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(job)
  const res = await leadsGET(new NextRequest(`http://test/api/leads?job_id=${job}`))
  assert.equal(res.status, 200)
  const j = await res.json() as { repeat_count: number; leads: { id: string }[] }
  assert.equal(j.repeat_count, 2)
  assert.ok(['zayed', 'dechert', 'ogletree'].every(id => j.leads.some(l => l.id === id)), 'the API itself hides no repeat')
})
