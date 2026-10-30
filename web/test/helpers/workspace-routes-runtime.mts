// Two workspaces, real sessions and memberships end to end (no stubbed user): the real route handlers, the real
// requireUser (workspace-session-service.ts) and the real getSessionUser. Member B of workspace A sees A's work, is held
// to their role, and loses access on the very next request once removed. Any outbound fetch fails the run.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { withJar } from './pg-session-headers.ts'
import { setScanDb } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { createPasswordUser, createSession, hashToken } from '../../lib/auth-db.ts'

globalThis.fetch = (async (u: unknown) => { throw new Error(`Unexpected network call ${String(u)}`) }) as typeof fetch

const raw = new Database(':memory:')
migrateAllSqlite(raw)
setScanDb(raw)
const jobsRoute = await import('../../app/api/scan/jobs/route.ts')
const scanRoute = await import('../../app/api/scan/route.ts')
const keyRoute = await import('../../app/api/settings/llm-key/route.ts')
const exportRoute = await import('../../app/api/leads/export/route.ts')

const req = (path: string, method = 'GET', body?: unknown) => new NextRequest(`http://localhost${path}`, {
  method, headers: { 'content-type': 'application/json', host: 'localhost', origin: 'http://localhost' }, body: body === undefined ? undefined : JSON.stringify(body) })
const as = <T,>(token: string, fn: () => Promise<T>) => withJar(new Map([['dazl_session', token]]), fn)
const jobs = async (token: string) => {
  const r = await as(token, () => jobsRoute.GET())
  return r.status === 200 ? ((await r.json()) as { jobs: { id: string }[] }).jobs.map(j => j.id) : r.status
}
const user = (id: string) => ({ id, email: `${id.toLowerCase()}@example.test`, name: id, business_name: `Biz ${id}`, password_hash: 'h'.repeat(128), salt: 's'.repeat(32) })

test('a member acts in the workspace they chose, within their role, until removed', async () => {
  for (const id of ['A', 'B', 'C']) await createPasswordUser(user(id))
  const now = Math.floor(Date.now() / 1000)
  for (const [job, t] of [['aaaaaaaaaaaaaaaaaaaaaaaa', 'A'], ['cccccccccccccccccccccccc', 'C']] as const) {
    raw.prepare("INSERT INTO scan_jobs (id, user_id, status, business_name, industry, location, created_at) VALUES (?, ?, 'done', 'x', 'y', 'z', ?)").run(job, t, now)
  }
  const ta = await createSession('A'), tb = await createSession('B')
  const choose = (tenant: string | null) => raw.prepare('UPDATE sessions SET active_tenant_id = ? WHERE id = ?').run(tenant, hashToken(tb))
  const member = (role: string | null) => role === null
    ? raw.prepare("DELETE FROM memberships WHERE tenant_id = 'A' AND member_id = 'B'").run()
    : raw.prepare("INSERT INTO memberships (tenant_id, member_id, role, created_at, added_by) VALUES ('A', 'B', ?, 1, 'A') ON CONFLICT (tenant_id, member_id) DO UPDATE SET role = excluded.role").run(role)

  assert.deepEqual(await jobs(ta), ['aaaaaaaaaaaaaaaaaaaaaaaa'])
  assert.deepEqual(await jobs(tb), [], "B's own workspace is empty")

  // B, a viewer of A, working in A: reads and exports A's work, cannot launch or configure
  member('viewer'); choose('A')
  assert.deepEqual(await jobs(tb), ['aaaaaaaaaaaaaaaaaaaaaaaa'])
  assert.notEqual((await as(tb, () => exportRoute.GET(req('/api/leads/export?job_id=aaaaaaaaaaaaaaaaaaaaaaaa')))).status, 403)
  const launch = () => as(tb, () => scanRoute.POST(req('/api/scan', 'POST', { query: 'roofers in Ohio' })))
  assert.equal((await launch()).status, 403)
  const putKey = () => as(tb, () => keyRoute.PUT(req('/api/settings/llm-key', 'PUT', { vendor: 'anthropic', key: 'sk-ant-FIXTURE' })))
  assert.equal((await putKey()).status, 403)
  assert.equal((raw.prepare("SELECT count(*) AS n FROM scan_jobs WHERE user_id = 'A'").get() as { n: number }).n, 1)

  // as an operator B may launch, but A's free trial is A's own: with no key in A, B's launch is refused for that
  member('operator')
  const r = await launch()
  assert.equal(r.status, 400); assert.deepEqual(await r.json(), { error: 'no_api_key' })
  assert.equal((await putKey()).status, 403, 'operators do not configure keys')

  // removed: the request meant for A fails at once; the next one is back in B's own workspace
  member(null)
  assert.equal(await jobs(tb), 401)
  assert.deepEqual(await jobs(tb), [])

  // a session pointed at a workspace B never belonged to gets nothing
  choose('C')
  assert.equal(await jobs(tb), 401)
  assert.deepEqual(await jobs(ta), ['aaaaaaaaaaaaaaaaaaaaaaaa'], "A is untouched throughout")
  console.log('WORKSPACE ROUTES ok')
})
