import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateWarm, importConnectionsCsv, normalizeLinkedInUrl, warmPathsForLead, addUserReportedPath, removeUserReportedPath } from '../lib/warm/connections.ts'

function db(): Database.Database {
  const d = new Database(':memory:')
  migrateWarm(d)
  d.exec(`CREATE TABLE lead_enrichments (id TEXT PRIMARY KEY, lead_id TEXT NOT NULL, tenant_id TEXT NOT NULL, connector TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, label TEXT, confidence INTEGER, source_url TEXT NOT NULL, source_date TEXT NOT NULL, retrieved_at INTEGER NOT NULL)`)
  return d
}

const CSV = `First Name,Last Name,URL,Email Address,Company,Position,Connected On
Ada,Lovelace,https://www.linkedin.com/in/adalovelace,ada@example.com,Analytical Engines,CEO,15 Mar 2024
"Grace, Jr",Hopper,https://linkedin.com/in/gracehopper/,grace@example.com,Navy,Admiral,01 Jan 2023
NoUrl,Person,,nope@example.com,Nowhere,Nothing,02 Feb 2024
`

test('normalizeLinkedInUrl handles scheme/www/locale/trailing variants, rejects non-profiles', () => {
  assert.equal(normalizeLinkedInUrl('https://www.linkedin.com/in/FooBar/'), 'linkedin.com/in/foobar')
  assert.equal(normalizeLinkedInUrl('linkedin.com/in/foobar?trk=xyz'), 'linkedin.com/in/foobar')
  assert.equal(normalizeLinkedInUrl('https://uk.linkedin.com/in/foobar'), 'linkedin.com/in/foobar')
  assert.equal(normalizeLinkedInUrl('https://www.linkedin.com/company/acme'), null)
  assert.equal(normalizeLinkedInUrl('not a url'), null)
})

test('import parses quoted CSV, skips rows without URL, replaces on re-import', () => {
  const d = db()
  const r1 = importConnectionsCsv(d, 'tenant1', CSV)
  assert.equal(r1.imported, 2)
  assert.equal(r1.skipped, 1)
  const r2 = importConnectionsCsv(d, 'tenant1', 'First Name,Last Name,URL\nSolo,Person,https://www.linkedin.com/in/solo\n')
  assert.equal(r2.imported, 1)
  const count = (d.prepare('SELECT COUNT(*) c FROM tenant_connections WHERE tenant_id = ?').get('tenant1') as { c: number }).c
  assert.equal(count, 1) // replaced, not merged - stale connections never linger
})

test('import with missing URL column imports nothing and counts skips', () => {
  const d = db()
  const r = importConnectionsCsv(d, 'tenant1', 'Name,Email\nBob,bob@example.com\n')
  assert.deepEqual(r, { imported: 0, skipped: 1, replaced: 0, capped: false })
})

test('warmPathsForLead: first-degree on URL match only, manual_check otherwise, never name-matched', () => {
  const d = db()
  importConnectionsCsv(d, 'tenant1', CSV)
  const ins = d.prepare(`INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, source_url, source_date, retrieved_at) VALUES (?, 'lead1', 'tenant1', 'apollo', 'contact', ?, ?, '2026-10-22', 0)`)
  ins.run('e1', 'Ada Lovelace - CEO', 'https://www.linkedin.com/in/adalovelace/')
  ins.run('e2', 'Alan Turing - Staff Engineer', 'https://www.linkedin.com/in/alanturing')
  ins.run('e3', 'No Profile Person', 'https://example.com/not-linkedin')
  const w = warmPathsForLead(d, 'tenant1', 'lead1')
  assert.equal(w.first_degree.length, 1)
  assert.equal(w.first_degree[0].connection_name, 'Ada Lovelace')
  assert.equal(w.first_degree[0].contact_title, 'CEO')
  assert.equal(w.manual_check.length, 1) // Turing: real profile, no match - user checks mutuals by hand
  assert.equal(w.imported_connections, 2)
})

test('warm paths are tenant-isolated', () => {
  const d = db()
  importConnectionsCsv(d, 'tenant1', CSV)
  d.prepare(`INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, source_url, source_date, retrieved_at) VALUES ('e1', 'lead2', 'tenant2', 'apollo', 'contact', 'Ada Lovelace - CEO', 'https://www.linkedin.com/in/adalovelace', '2026-10-22', 0)`).run()
  const w = warmPathsForLead(d, 'tenant2', 'lead2')
  assert.equal(w.first_degree.length, 0) // tenant2 has no import - no borrowed graph
  assert.equal(w.manual_check.length, 1)
})

test('re-import preserves user-reported paths and never deletes them', () => {
  const d = db()
  importConnectionsCsv(d, 'tenant1', CSV)
  d.prepare(`INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, source_url, source_date, retrieved_at) VALUES ('e1', 'lead1', 'tenant1', 'apollo', 'contact', 'Alan Turing - Eng', 'https://www.linkedin.com/in/alanturing', '2026-10-22', 0)`).run()
  const p = addUserReportedPath(d, 'tenant1', 'lead1', 'https://www.linkedin.com/in/alanturing', 'Margaret Hamilton')
  assert.ok(p)
  importConnectionsCsv(d, 'tenant1', 'First Name,Last Name,URL\nSolo,Person,https://www.linkedin.com/in/solo\n')
  const w = warmPathsForLead(d, 'tenant1', 'lead1')
  assert.equal(w.user_reported.length, 1)
  assert.equal(w.user_reported[0].mutual_name, 'Margaret Hamilton')
})

test('deleteConnections wipes the import only, user paths survive; import status reports counts', async () => {
  const { deleteConnections, connectionImportStatus } = await import('../lib/warm/connections.ts')
  const d = db()
  importConnectionsCsv(d, 'tenant1', CSV)
  d.prepare(`INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, source_url, source_date, retrieved_at) VALUES ('e1', 'lead1', 'tenant1', 'apollo', 'contact', 'Alan Turing - Eng', 'https://www.linkedin.com/in/alanturing', '2026-10-22', 0)`).run()
  addUserReportedPath(d, 'tenant1', 'lead1', 'https://www.linkedin.com/in/alanturing', 'Margaret Hamilton')
  assert.equal(connectionImportStatus(d, 'tenant1').count, 2)
  assert.equal(deleteConnections(d, 'tenant1'), 2)
  assert.equal(connectionImportStatus(d, 'tenant1').count, 0)
  assert.equal(warmPathsForLead(d, 'tenant1', 'lead1').user_reported.length, 1)
})

test('formula-injection cells are neutralized or rejected', async () => {
  const { sanitizeCell } = await import('../lib/warm/connections.ts')
  assert.equal(sanitizeCell('=cmd|"/c calc"!A1'), "'=cmd|\"/c calc\"!A1")
  assert.equal(sanitizeCell('+1234'), "'+1234")
  const d = db()
  const r = importConnectionsCsv(d, 'tenant1', 'First Name,Last Name,URL\n=HYPERLINK,Evil,https://www.linkedin.com/in/evil\nGood,Person,https://www.linkedin.com/in/good\n')
  assert.equal(r.imported, 1) // formula-named row rejected, good row kept
  const w = warmPathsForLead(d, 'tenant1', 'x')
  assert.equal(w.imported_connections, 1)
})

test('user-reported path requires a valid profile URL and name, dedupes, removes', () => {
  const d = db()
  assert.equal(addUserReportedPath(d, 'tenant1', 'lead1', 'https://example.com/not-linkedin', 'Bob'), null)
  assert.equal(addUserReportedPath(d, 'tenant1', 'lead1', 'https://www.linkedin.com/in/x', '  '), null)
  const p = addUserReportedPath(d, 'tenant1', 'lead1', 'https://www.linkedin.com/in/x/', 'Bob')
  assert.ok(p)
  assert.equal(addUserReportedPath(d, 'tenant1', 'lead1', 'https://www.linkedin.com/in/x', 'Bob')!.id, p!.id) // dedupe
  assert.equal(removeUserReportedPath(d, 'tenant1', p!.id), true)
  assert.equal(removeUserReportedPath(d, 'tenant1', p!.id), false)
})
