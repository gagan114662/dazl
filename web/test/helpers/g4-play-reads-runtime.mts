import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { GET as runs } from '../../app/api/plays/[kind]/[id]/runs/route.ts'
import { GET as fresh } from '../../app/api/plays/[kind]/[id]/new/route.ts'
import { GET as report } from '../../app/api/monitors/[id]/route.ts'
import { GET as inbox } from '../../app/api/outreach/inbox/route.ts'

const hex = () => randomBytes(12).toString('hex')
const owner = { id: hex(), business_name: hex() }, other = { id: hex(), business_name: hex() }
const monitor = hex(), watch = hex(), job = hex(), thread = hex(), marker = hex(), run = hex(), lead = hex()
const dbWork: string[] = []
const req = (query = '') => new NextRequest('http://localhost/' + query)
const ctx = (id: string, kind = 'monitor') => ({ params: Promise.resolve({ id, kind }) })

test('entity reads use the same denial for an unknown or unowned entity', async t => {
  const db = new Database(':memory:', { verbose: sql => dbWork.push(String(sql)) })
  t.after(() => db.close())
  migrateAllSqlite(db)
  setScanDb(db)
  db.prepare("INSERT INTO watches(id,user_id,query,icp,next_run_at) VALUES(?,?,?,'{}',1)").run(watch, owner.id, marker)
  db.prepare('INSERT INTO monitors(id,user_id,query,interval_hours) VALUES(?,?,?,48)').run(monitor, owner.id, marker)
  db.prepare("INSERT INTO scan_jobs(id,user_id,business_name,industry,location,status,watch_id) VALUES(?,?,?,'test','test','running',?)").run(job, owner.id, marker, watch)
  db.prepare("INSERT INTO leads(id,scan_job_id,name,company,signal,source_url,watch_new) VALUES(?,?,'',?,'test','https://example.invalid',1)").run(lead, job, marker)
  db.prepare("UPDATE scan_jobs SET status='done' WHERE id=?").run(job)
  db.prepare('INSERT INTO monitor_runs(id,monitor_id,job_id) VALUES(?,?,?)').run(run, monitor, job)
  db.prepare("INSERT INTO monitor_alerts(id,user_id,monitor_id,run_id,event_key,kind,company,latency_s,at) VALUES(?,?,?,?,?,'new_company',?,0,1)").run(hex(), owner.id, monitor, run, hex(), marker)
  db.prepare('INSERT INTO monitor_cursors(monitor_id,source,last_checked_at) VALUES(?,?,1)').run(monitor, marker)
  db.prepare("INSERT INTO inbound_messages(gmail_id,tenant_id,thread_id,lead_id,from_email,excerpt,classification,received_at) VALUES(?,?,?,?,'fixture@example.invalid',?,'positive',1)").run(hex(), owner.id, thread, lead, marker)
  const root = hex()
  db.prepare("INSERT INTO outreach_messages(id,tenant_id,lead_id,to_email,subject,body,status) VALUES(?,?,?,'fixture@example.invalid',?,?,'sent')").run(root, owner.id, lead, marker, marker)
  db.prepare("INSERT INTO followup_threads(tenant_id,thread_id,lead_id,to_email,root_message_id,last_activity_at) VALUES(?,?,?,'fixture@example.invalid',?,1)").run(owner.id, thread, lead, root)

  const cases: [string, string, string, (id: string) => Promise<Response>][] = [
    ['monitor report', monitor, marker, id => report(req(), ctx(id))],
    ['monitor runs', monitor, job, id => runs(req(), ctx(id))],
    ['watch runs', watch, job, id => runs(req(), ctx(id, 'watch'))],
    ['monitor new', monitor, marker, id => fresh(req(), ctx(id))],
    ['watch new', watch, marker, id => fresh(req(), ctx(id, 'watch'))],
    ['inbox direct thread', thread, marker, id => inbox(req('?thread_id=' + id))],
    ['inbox thread filter', thread, marker, id => inbox(req('?thread=' + id))],
    ['inbox job filter', job, marker, id => inbox(req('?job_id=' + id))],
  ]
  for (const [name, id, expected, read] of cases) await t.test(name, async () => {
    setUser(owner)
    const own = await read(id)
    assert.equal(own.status, 200)
    assert.ok((await own.text()).includes(expected))
    setUser(other)
    const denied = async (lookup: string) => {
      dbWork.length = 0
      const res = await read(lookup)
      return { status: res.status, body: await res.text(), work: dbWork.map(sql => sql.replaceAll(lookup, '<id>')) }
    }
    const foreign = await denied(id)
    assert.equal(foreign.status, 404)
    assert.deepEqual(Object.keys(JSON.parse(foreign.body)), ['error'])
    for (const value of [owner.id, id, expected, marker]) assert.ok(!foreign.body.includes(value))
    assert.ok(foreign.work.length)
    assert.deepEqual(await denied(hex()), foreign)
  })
})
