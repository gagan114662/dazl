// #1042: the real POST /api/plays/[kind]/[id]/run and GET /api/plays/[kind]/[id]/new handlers on an in-memory store,
// network fenced, runner never started (after() is captured by the loader's next/server shim and never flushed).
// Synthetic tenant and plays only; no paid call: the run only queues a job, exactly as the scheduler does.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { sqliteDb } from '../../lib/db/client.ts'
import { createMonitor } from '../../lib/monitors.ts'
import { createWatch } from '../../lib/watch.ts'
import { POST as RUN } from '../../app/api/plays/[kind]/[id]/run/route.ts'
import { GET as NEW } from '../../app/api/plays/[kind]/[id]/new/route.ts'

globalThis.fetch = (async (u: unknown) => { throw new Error(`network fenced: ${String(u)}`) }) as typeof fetch
const ctx = (kind: string, id: string) => ({ params: Promise.resolve({ kind, id }) })
const post = (kind: string, id: string, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
  RUN(new NextRequest(`http://localhost/api/plays/${kind}/${id}/run`, { method: 'POST', headers, body: '{}' }), ctx(kind, id))
const get = (kind: string, id: string, q: string) => NEW(new Request(`http://localhost/api/plays/${kind}/${id}/new${q}`), ctx(kind, id))

test('#1042 Find leads now and what\'s new through the real route handlers', async () => {
  const raw = new Database(':memory:'); migrateAllSqlite(raw); setScanDb(raw)
  const db = sqliteDb(raw), now = Math.floor(Date.now() / 1000)
  const m = await createMonitor(db, 'A', { query: 'Dental practices in Leeds hiring a practice manager' }, now - 86400)
  assert.ok('id' in m)
  raw.prepare('UPDATE monitors SET next_run_at = ? WHERE id = ?').run(now + 3 * 86400, m.id)
  const w = (await createWatch(db, 'A', 'Roofers in Ohio', '{"summary":"s"}', null, now - 86400)).watch!
  raw.prepare("INSERT INTO tenant_llm_keys (tenant_id, vendor, ciphertext, last4, validated_at) VALUES ('A', 'anthropic', 'x', '1234', 1)").run()
  const jobs = () => raw.prepare('SELECT id, query, status FROM scan_jobs').all() as { id: string; query: string; status: string }[]

  setUser(null)
  assert.equal((await post('monitor', m.id)).status, 401)
  // a viewer cannot start a run (operate role), and a cross-site / non-JSON post is refused before anything runs
  setUser({ id: 'A', business_name: 'Acme', role: 'viewer', actorId: 'V' })
  assert.equal((await post('monitor', m.id)).status, 403)
  setUser({ id: 'A', business_name: 'Acme' })
  assert.equal((await post('monitor', m.id, {})).status, 400)
  // malformed path parts: not found, nothing written
  for (const [k, id] of [['campaign', m.id], ['monitor', 'zz'], ['monitor', m.id.toUpperCase()], ['monitor', `${m.id}0`], ['watch', '../../x']] as const) {
    const r = await post(k, id)
    assert.equal(r.status, 404, `${k}/${id}`)
  }
  assert.deepEqual(jobs(), [])

  // the run: 202 with the job, recorded in the audit trail; the next scheduled run moved
  const r = await post('monitor', m.id)
  const body = await r.json() as { job_id: string; next_run_at: number }
  assert.equal(r.status, 202, JSON.stringify(body))
  assert.deepEqual(jobs().map(j => [j.id, j.query, j.status]), [[body.job_id, 'Dental practices in Leeds hiring a practice manager', 'pending']])
  const ev = raw.prepare("SELECT tenant_id, action, resource_type, resource_id FROM audit_events WHERE action = 'play.run_now'").all()
  assert.deepEqual(ev, [{ tenant_id: 'A', action: 'play.run_now', resource_type: 'monitor', resource_id: m.id }])
  // a second press: refused with a time to come back, and a scan is still queued for the account anyway
  const again = await post('monitor', m.id)
  assert.equal(again.status, 429)
  assert.equal((await again.json() as { error: string }).error, 'too_soon')
  const other = await post('watch', w.id)
  assert.deepEqual([other.status, (await other.json() as { error: string }).error], [409, 'scan_active'], 'one scan at a time per account')
  assert.equal(jobs().length, 1)

  // what's new: input checks, then the empty answer
  for (const q of ['?since=abc', '?since=-1', '?since=1.5', `?since=${'9'.repeat(13)}`, '?since=', '?since=1e9']) assert.equal((await get('monitor', m.id, q)).status, 400, q)
  assert.equal((await get('monitor', 'nothex', '')).status, 404)
  const ok = await get('watch', w.id, '?since=0')
  assert.equal(ok.status, 200)
  assert.deepEqual(await ok.json(), { since: 0, total: 0, latest_at: null, items: [] })
  assert.deepEqual(await (await get('watch', w.id, '')).json(), { since: 0, total: 0, latest_at: null, items: [] }, 'no since: ever')
  setUser({ id: 'B', business_name: 'Beta' })
  assert.equal((await get('watch', w.id, '?since=0')).status, 404)
})
