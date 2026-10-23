import { test } from 'node:test'
import assert from 'node:assert/strict'
import { eventDateCopy } from '../lib/scan/date-copy.ts'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { migrateScan, createJob, exportLeads } from '../lib/scan/store.ts'

test('unknown event date is never presented as fresh just because a scan ran', () => {
  for (const status of [null, 'undated', 'verified'])
    assert.equal(eventDateCopy(null, status), 'event date unknown - current need not confirmed')
})
test('date occurrence is distinct from current need, even when date is verified', () => {
  assert.equal(eventDateCopy('2026-01-06', 'verified'), '2026-01-06 (date found on page; current need not confirmed)')
  for (const status of [null, 'unverified', 'undated'])
    assert.equal(eventDateCopy('2026-01-06', status), '2026-01-06 (date not confirmed on page; current need not confirmed)')
})
test('export read preserves raw event date status with tenant isolation and no inferred date', () => {
  const db = new Database(':memory:'); migrateScan(db)
  const job = createJob(db, 'A', { business_name: 'Acme', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status='running' WHERE id=?").run(job)
  db.prepare("INSERT INTO leads(id,scan_job_id,company,signal,source_url,date_status) VALUES('date-test',?,'Acme','signal','https://acme.example','undated')").run(job)
  const row = (exportLeads(db, 'A') as {event_date:null;date_status:string}[])[0]
  assert.equal(row.event_date, null); assert.equal(row.date_status, 'undated')
  assert.deepEqual(exportLeads(db, 'B'), [])
  db.close()
})
test('lead UI and CSV both expose date context alongside raw date fields', () => {
  const read = (p:string) => readFileSync(new URL(`../${p}`,import.meta.url),'utf8')
  assert.match(read('app/app/leads/leads-client.tsx'), /eventDateCopy\(l.event_date, l.date_status\)/)
  const route = read('app/api/leads/export/route.ts')
  assert.match(route, /key: 'date_status'/); assert.match(route, /key: 'date_context'/)
  assert.match(route, /date_context: eventDateCopy/)
})
