// #1182: the Leads page reads every lead's stored Find work email answer in ONE tenant-scoped query, not one GET per lead.
// Synthetic SQLite, invented data, no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { workEmailsFor, workEmailsForLeads, workEmailPageRead, PENDING_STALE_S } from '../lib/people/work-email.ts'

const NOW = 1_800_000_000
const id = (n: number) => n.toString(16).padStart(24, '0')
function seed() {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  const ins = db.prepare("INSERT INTO work_email_lookups (tenant_id, lead_id, target, status, provider, address, detail, updated_at, source_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
  ins.run('A', id(1), 'Dana Lee|Owner', 'published', 'site', 'dana@harbor.example', 'printed on the team page', NOW, 'https://harbor.example/team')
  ins.run('A', id(1), 'Owen Park|CFO', 'not_found', 'pdl', null, 'no match', NOW, null)
  ins.run('A', id(2), 'Sam Roe|Owner', 'uncertain', 'pdl', null, 'timed out', NOW, null)
  ins.run('A', id(3), 'Pat Fox|Owner', 'pending', 'pdl', null, '', NOW - PENDING_STALE_S - 5, null) // died
  ins.run('B', id(1), 'Other Tenant|Owner', 'published', 'site', 'secret@other.example', 'x', NOW, 'https://other.example/') // same lead id, other tenant
  return db
}

test('workEmailsForLeads: one read for many leads, grouped, tenant-scoped, same mapping as the per-lead read', () => {
  const db = seed()
  const real = db.prepare.bind(db); const sqls: string[] = []
  db.prepare = ((s: string) => { sqls.push(s); return real(s) }) as typeof db.prepare
  const all = workEmailsForLeads(db, 'A', [id(1), id(2), id(3), id(4)], NOW)
  const lookups = sqls.filter(s => /FROM work_email_lookups/.test(s) && /lead_id IN/.test(s))
  assert.equal(lookups.length, 1, 'ONE query for four leads')
  assert.match(lookups[0], /tenant_id = \?/)
  assert.deepEqual(Object.keys(all).sort(), [id(1), id(2), id(3)])
  assert.equal(all[id(1)].length, 2)
  assert.ok(!JSON.stringify(all).includes('secret@other.example'), "another tenant's lookup is never returned")
  assert.equal(all[id(3)][0].status, 'uncertain', 'a stale pending row reads uncertain, like the per-lead read')
  for (const l of [id(1), id(2), id(3)]) assert.deepEqual(all[l], workEmailsFor(db, 'A', l, NOW), `identical to the per-lead read for ${l}`)
})

test('workEmailsForLeads: junk ids are ignored; more than 200 leads are chunked; empty is empty', () => {
  const db = seed()
  assert.deepEqual(workEmailsForLeads(db, 'A', [], NOW), {})
  assert.deepEqual(workEmailsForLeads(db, 'A', ["x' OR 1=1 --", '', id(99)], NOW), {})
  const many = Array.from({ length: 450 }, (_, i) => id(i + 1))
  const real = db.prepare.bind(db); let n = 0
  db.prepare = ((s: string) => { if (/lead_id IN/.test(s)) n++; return real(s) }) as typeof db.prepare
  assert.equal(Object.keys(workEmailsForLeads(db, 'A', many, NOW)).length, 3)
  assert.equal(n, 3, '450 ids = 3 chunks of at most 200')
})

test('workEmailsForLeads uses the primary key (tenant_id first), not a scan', () => {
  const db = seed()
  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT lead_id FROM work_email_lookups WHERE tenant_id = ? AND lead_id IN (?, ?) ORDER BY lead_id, target`).all('A', id(1), id(2)) as { detail: string }[]
  assert.ok(plan.some(p => /USING (COVERING )?INDEX|PRIMARY KEY/i.test(p.detail)) && !plan.some(p => /^SCAN/.test(p.detail)), JSON.stringify(plan))
})

test('workEmailPageRead: providers once, lookups by lead', () => {
  const db = seed()
  const r = workEmailPageRead(db, 'A', [{ id: id(1), company: 'Harbor Dental' }, { id: id(2), company: 'Roe & Co' }], {})
  assert.equal(typeof r.providers.mailboxCheck, 'boolean')
  assert.deepEqual(r.providers_by_lead, {})
  assert.equal(r.lookups[id(1)].length, 2)
})
