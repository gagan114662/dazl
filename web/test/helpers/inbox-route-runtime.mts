// GET /api/outreach/inbox (paged, filtered list) and POST /api/outreach/inbox (mark read) through the real handlers, two
// tenants on one fixture store, session switched per call. Synthetic data; fetch throws.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { GET, POST } from '../../app/api/outreach/inbox/route.ts'

globalThis.fetch = (async () => { throw new Error('Unexpected network call') }) as typeof fetch
const A = { id: 'A', business_name: 'Acme' }, B = { id: 'B', business_name: 'Beta' }
const get = (q: string) => GET(new NextRequest(`http://localhost/api/outreach/inbox${q}`, { method: 'GET' }))
const post = (body: unknown) => POST(new NextRequest('http://localhost/api/outreach/inbox', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', origin: 'http://localhost', host: 'localhost' } }))
const NOW = 1_800_000_000
const PA = 'a'.repeat(24), PA2 = 'c'.repeat(24), PB = 'b'.repeat(24)

function build() {
  const db = new Database(':memory:')
  migrateAllSqlite(db)
  const job = db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES (?, ?, 'Biz', 'test', 'test', 'running')")
  const lead = db.prepare("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url) VALUES (?, ?, 'Pat', ?, 'hiring', 'https://x.example/a')")
  const reply = db.prepare('INSERT INTO inbound_messages (gmail_id, tenant_id, thread_id, lead_id, from_email, excerpt, classification, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  job.run(PA, 'A'); job.run(PA2, 'A'); job.run(PB, 'B')
  lead.run('la-old', PA, 'AMARKER-OLDCO')
  reply.run('ga-old', 'A', 'AMARKER-THREAD-OLD', 'la-old', 'a@x.example', 'AMARKER yes please', 'positive', NOW - 40 * 86400)
  for (let i = 0; i < 120; i++) { lead.run(`la${i}`, PA2, `AMARKER-BUSY-${i}`); reply.run(`ga${i}`, 'A', `AMARKER-T${i}`, `la${i}`, 'a@x.example', 'AMARKER tell me more', 'positive', NOW - i) }
  lead.run('lb', PB, 'BMARKER-CO')
  reply.run('gb', 'B', 'BMARKER-THREAD', 'lb', 'b@x.example', 'BMARKER interested', 'positive', NOW)
  setScanDb(db)
  return db
}

test('GET /api/outreach/inbox paged list and POST /api/outreach/inbox read: own data only, older play conversation discoverable, totals exact', async () => {
  const db = build()
  setUser(null)
  assert.equal((await get('')).status, 401)
  assert.equal((await post({ thread_id: 'x', action: 'read' })).status, 401)

  setUser(A)
  const first = await (await get('?status=needs_owner&limit=50')).json()
  assert.equal(first.threads.length, 50); assert.ok(first.next_cursor)
  assert.deepEqual(first.counts, { threads: 121, needs_owner: 121, unread: 121, unread_needs_owner: 121 })
  const second = await (await get(`?status=needs_owner&limit=50&cursor=${encodeURIComponent(first.next_cursor)}`)).json()
  assert.equal(second.threads.length, 50)
  assert.equal(new Set([...first.threads, ...second.threads].map((t: { thread_id: string }) => t.thread_id)).size, 100)
  // The older play's conversation, behind 120 newer replies of another play, is the first row of its own play.
  const play = await (await get(`?job_id=${PA}&status=needs_owner`)).json()
  assert.deepEqual(play.threads.map((t: { thread_id: string }) => t.thread_id), ['AMARKER-THREAD-OLD'])
  assert.equal(play.next_cursor, null)
  const all = JSON.stringify([first, second, play])
  assert.ok(!all.includes('BMARKER'), 'no B data in A\'s pages')

  // Bad input is refused.
  assert.equal((await get('?status=everything')).status, 400)
  assert.equal((await get('?cursor=garbage')).status, 400)
  assert.equal((await post({ thread_id: 'AMARKER-T1' })).status, 400)
  // Same-origin JSON only (lib/same-origin.ts), as the neighbouring cookie-authenticated writes: nothing is marked.
  const foreign = (headers: Record<string, string>) => POST(new NextRequest('http://localhost/api/outreach/inbox', { method: 'POST', body: JSON.stringify({ thread_id: 'AMARKER-T3', action: 'read' }), headers }))
  assert.equal((await foreign({ 'content-type': 'application/json', origin: 'https://evil.example' })).status, 400)
  assert.equal((await foreign({ 'content-type': 'text/plain' })).status, 400)
  assert.equal((db.prepare("SELECT count(*) AS n FROM inbox_thread_reads WHERE thread_id = 'AMARKER-T3'").get() as { n: number }).n, 0)

  // Mark read: own thread only; another tenant's thread answers exactly like an unknown one and writes nothing.
  assert.equal((await post({ thread_id: 'AMARKER-T1', action: 'read' })).status, 200)
  assert.equal((await (await get('')).json()).counts.unread, 120)
  setUser(B)
  const cross = await post({ thread_id: 'AMARKER-T2', action: 'read' })
  const unknown = await post({ thread_id: 'no-such-thread', action: 'read' })
  assert.equal(cross.status, 404); assert.equal(await cross.text(), await unknown.text())
  assert.deepEqual(db.prepare("SELECT tenant_id, thread_id FROM inbox_thread_reads ORDER BY thread_id").all(), [{ tenant_id: 'A', thread_id: 'AMARKER-T1' }])
  // B's list: B's own row only, A's play id filters to nothing.
  const b = await (await get('')).json()
  assert.deepEqual(b.threads.map((t: { thread_id: string }) => t.thread_id), ['BMARKER-THREAD'])
  assert.ok(!JSON.stringify(b).includes('AMARKER'))
  const bOnA = await (await get(`?job_id=${PA}`)).json()
  assert.deepEqual([bOnA.threads.length, bOnA.counts.threads], [0, 0])
})

test('POST /api/outreach/inbox read is an operator write: a viewer of A is refused and marks nothing; the viewer still reads A; an operator marks', async () => {
  const db = build()
  const reads = () => db.prepare('SELECT tenant_id, thread_id FROM inbox_thread_reads ORDER BY tenant_id, thread_id').all()
  setUser({ id: 'A', actorId: 'V', role: 'viewer', business_name: 'Acme' })
  const refused = await post({ thread_id: 'AMARKER-T1', action: 'read' })
  assert.equal(refused.status, 403)
  assert.deepEqual(await refused.json(), { error: 'forbidden', needs: 'operate' })
  assert.deepEqual(reads(), [])
  const seen = await (await get('?limit=5')).json()
  assert.equal(seen.counts.unread, 121, 'the viewer reads A\'s inbox, and reading marks nothing')
  assert.deepEqual(reads(), [])
  setUser({ id: 'A', actorId: 'O', role: 'operator', business_name: 'Acme' })
  assert.equal((await post({ thread_id: 'AMARKER-T1', action: 'read' })).status, 200)
  assert.deepEqual(reads(), [{ tenant_id: 'A', thread_id: 'AMARKER-T1' }])
})
