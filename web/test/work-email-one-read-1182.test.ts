// #1182: the Leads page reads every lead's Find work email answer in one batched, tenant-scoped read, not one GET per lead.
// #1036 / #1250: that read rebuilds the published address from the crawl; a stored lookup row (an old provider answer) is never read.
// Synthetic SQLite, invented data, no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { workEmailPageRead, PUBLISHED_ONLY_WORK_EMAIL_PROVIDERS } from '../lib/people/work-email.ts'

const NOW = 1_800_000_000
const id = (n: number) => n.toString(16).padStart(24, '0')
function seed() {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  const ins = db.prepare("INSERT INTO work_email_lookups (tenant_id, lead_id, target, status, provider, address, detail, updated_at, source_url, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
  ins.run('A', id(1), 'Dana Lee|Owner', 'verified', 'apollo', 'dana@harbor.example', 'apollo said verified', NOW, null, NOW)
  ins.run('A', id(2), 'Sam Roe|Owner', 'unverified', 'pdl', 'sam@roe.example', 'found', NOW, null, null)
  ins.run('B', id(1), 'Other Tenant|Owner', 'published', 'site', 'secret@other.example', 'x', NOW, 'https://other.example/', null)
  return db
}
const spy = (db: Database.Database) => {
  const real = db.prepare.bind(db); const sqls: string[] = []
  db.prepare = ((s: string) => { sqls.push(s); return real(s) }) as typeof db.prepare
  return sqls
}

test('workEmailPageRead: published-only providers, no stored lookup row is read or returned', () => {
  const db = seed(); const sqls = spy(db)
  const r = workEmailPageRead(db, 'A', [{ id: id(1) }, { id: id(2) }])
  assert.deepEqual(r.providers, PUBLISHED_ONLY_WORK_EMAIL_PROVIDERS)
  assert.deepEqual(r.guesses, {})
  assert.equal(sqls.some(s => /FROM work_email_lookups/i.test(s)), false, 'an old provider answer is never read')
  assert.ok(!JSON.stringify(r).includes('@'), 'no stored address comes back')
})

test('workEmailPageRead: junk ids are ignored; more than 200 leads are chunked; empty is empty', () => {
  const db = seed()
  assert.deepEqual(workEmailPageRead(db, 'A', []).lookups, {})
  assert.deepEqual(workEmailPageRead(db, 'A', ["x' OR 1=1 --", '', id(99)].map(id => ({ id }))).lookups, {})
  const sqls = spy(db)
  workEmailPageRead(db, 'A', Array.from({ length: 450 }, (_, i) => ({ id: id(i + 1) })))
  const leadReads = sqls.filter(s => /FROM leads l JOIN scan_jobs/i.test(s))
  assert.equal(leadReads.length, 3, '450 ids = 3 chunks of at most 200')
  for (const s of leadReads) assert.match(s, /j\.user_id = \?/, 'tenant-scoped')
})
