import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import test from 'node:test'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { createJob } from '../../lib/scan/store.ts'
import { GET as feedback } from '../../app/api/leads/[lead]/feedback/route.ts'
import { GET as warmPath } from '../../app/api/leads/[lead]/warm-path/route.ts'
import { GET as workEmail } from '../../app/api/leads/[lead]/work-email/route.ts'
import { setScanDb, setUser } from './tenant-route-db.ts'

const id = () => randomBytes(12).toString('hex')
for (const [name, handler] of [
  ['feedback', feedback],
  ['warm path', warmPath],
  ['work email', workEmail],
] as const) {
  test(`lead ${name} is scoped to the session workspace`, async t => {
    const db = new Database(':memory:')
    t.after(() => { setUser(null); db.close() })
    migrateAllSqlite(db)
    setScanDb(db)
    const seed = (business_name: string) => {
      const user = { id: randomUUID(), business_name }
      const job = createJob(db, user.id, { business_name, industry: 'test', location: 'test' })
      db.prepare("UPDATE scan_jobs SET status = ? WHERE id = ?").run("running", job)
      const lead = id()
      db.prepare('INSERT INTO leads (id, scan_job_id, company, signal, source_url) VALUES (?, ?, ?, ?, ?)')
        .run(lead, job, business_name, 'Opened a depot', 'https://source.example/news')
      return { user, lead }
    }
    const a = seed('First workspace')
    const b = seed('Second workspace')
    const read = (lead: string) =>
      handler(new NextRequest('http://localhost'), { params: Promise.resolve({ lead }) })

    setUser(a.user)
    assert.equal((await read(a.lead)).status, 200)
    setUser(b.user)
    assert.equal((await read(b.lead)).status, 200)
    const missing = await read(id())
    const refused = await read(a.lead)
    assert.equal(missing.status, 404)
    assert.equal(refused.status, 404)
    assert.equal(refused.headers.get('content-type'), missing.headers.get('content-type'))
    assert.deepEqual(await refused.json(), await missing.json())
  })
}
