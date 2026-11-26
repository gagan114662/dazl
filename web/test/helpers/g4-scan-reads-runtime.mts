import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { createJob } from '../../lib/scan/store.ts'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { GET as leads } from '../../app/api/leads/route.ts'
import { GET as exportCsv } from '../../app/api/leads/export/route.ts'
import { GET as feed } from '../../app/api/leads/hiring-feed/route.ts'
import { GET as research } from '../../app/api/leads/play-research/route.ts'
import { GET as latest } from '../../app/api/scan/latest/route.ts'
import { GET as status } from '../../app/api/scan/status/route.ts'
import { GET as campaign } from '../../app/api/campaigns/[id]/route.ts'
import { GET as csv } from '../../app/api/scan/csv/[batch]/route.ts'
import { GET as commenters } from '../../app/api/scan/commenters/[batch]/route.ts'
import { GET as operator } from '../../app/api/internal/usable-check/route.ts'

const id = () => randomBytes(12).toString('hex')
const request = (path: string) => new NextRequest('http://localhost' + path)
const params = <T,>(p: T) => ({ params: Promise.resolve(p) })

test('scan object reads with a synthetic workspace session', async t => {
  let work: string[] | null = null
  const db = new Database(':memory:', { verbose(sql) {
    work?.push(String(sql).replace(/'(?:[^']|'')*'/g, '?').replace(/\b\d+\b/g, '?'))
  } })
  t.after(() => db.close())
  migrateAllSqlite(db)
  setScanDb(db)
  const owner = { id: id(), business_name: id() }
  const other = { id: id(), business_name: id() }
  for (const u of [owner, other]) {
    db.prepare("INSERT INTO users(id,email,password_hash,salt) VALUES (?,?,'x','y')").run(u.id, u.id + '@example.test')
  }
  const job = createJob(db, owner.id, { business_name: owner.business_name, industry: 'test', location: 'test' })
  const marker = id(), csvId = id(), commenterId = id()
  db.prepare("UPDATE scan_jobs SET status='running', query=?, claimed_at=unixepoch() WHERE id=?").run(marker, job)
  db.prepare("INSERT INTO leads(id,scan_job_id,company,name,signal,source_url,evidence_excerpt,human_confirmed_at) VALUES(?,?,?,'Test','Test','https://example.invalid',?,1)").run(id(), job, marker, marker)
  db.prepare('INSERT INTO csv_batches(id,user_id,total,note) VALUES(?,?,0,?)').run(csvId, owner.id, marker)
  db.prepare('INSERT INTO commenter_batches(id,user_id,total,context) VALUES(?,?,0,?)').run(commenterId, owner.id, marker)
  const routes: [string, string, string, (key: string) => Promise<Response | undefined>][] = [
    ['leads', job, marker, k => leads(request('/api/leads?job_id=' + k))],
    ['export', job, marker, k => exportCsv(request('/api/leads/export?job_id=' + k))],
    ['hiring feed', job, job, k => feed(request('/api/leads/hiring-feed?job_id=' + k))],
    ['play research', job, job, k => research(request('/api/leads/play-research?job_id=' + k))],
    ['campaign', job, marker, k => campaign(request('/api/campaigns/' + k), params({ id: k }))],
    ['status', job, job, k => status(request('/api/scan/status?job_id=' + k))],
    ['readonly status', job, job, k => status(request('/api/scan/status?readonly=1&job_id=' + k))],
    ['CSV batch', csvId, marker, k => csv(request('/api/scan/csv/' + k), params({ batch: k }))],
    ['commenter batch', commenterId, marker, k => commenters(request('/api/scan/commenters/' + k), params({ batch: k }))],
    ['latest by job', job, marker, k => latest(request('/api/scan/latest?job_id=' + k))],
  ]
  for (const [name, key, control, read] of routes) await t.test(name, async () => {
    setUser(owner)
    const own = await read(key)
    assert.equal(own?.status, 200)
    assert.ok((await own.text()).includes(control))
    setUser(other)
    const denied = async (k: string) => {
      work = []
      const response = await read(k)
      assert.ok(response)
      const result = { status: response.status, headers: [...response.headers], body: await response.text(), work }
      work = null
      return result
    }
    const foreign = await denied(key)
    assert.deepEqual(foreign, await denied(id()))
    assert.equal(foreign.status, 404)
    assert.match(foreign.body, /^\{"error":"(?:Play not found|Not found)"\}$/)
    assert.ok(foreign.work.length > 0)
  })
  await t.test('latest without a selected job preserves the empty workspace response', async () => {
    setUser(other)
    const response = await latest()
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { query: null, icp: null, icp_source: null })
  })
  await t.test('an empty explicit job selector never falls back to the latest scan', async () => {
    setUser(owner)
    const response = await latest(request('/api/scan/latest?job_id='))
    assert.equal(response.status, 404)
    assert.deepEqual(await response.json(), { error: 'Not found' })
  })
  await t.test('operator-only counts are unavailable to an ordinary workspace session', async () => {
    setUser(owner)
    process.env.AUTOPILOT_TICK_SECRET = id()
    try {
      for (const k of [job, id()]) {
        work = []
        const response = await operator(request('/api/internal/usable-check?job=' + k))
        assert.equal(response.status, 404)
        assert.deepEqual(await response.json(), { error: 'Not found' })
        assert.deepEqual(work, [])
      }
    } finally {
      delete process.env.AUTOPILOT_TICK_SECRET
      work = null
    }
  })
})
