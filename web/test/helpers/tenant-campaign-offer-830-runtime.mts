import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import test from 'node:test'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { createJob } from '../../lib/scan/store.ts'
import { POST } from '../../app/api/campaigns/[id]/route.ts'
import { setScanDb, setUser } from './tenant-route-db.ts'

test('campaign offer writes reject foreign and missing jobs identically', async t => {
  const db = new Database(':memory:')
  t.after(() => { setUser(null); db.close() })
  migrateAllSqlite(db)
  setScanDb(db)
  const seed = (business_name: string) => {
    const user = { id: randomUUID(), business_name }
    const job = createJob(db, user.id, { business_name, industry: 'test', location: 'test' })
    return { user, job }
  }
  const a = seed('First workspace')
  const b = seed('Second workspace')
  const offer = (job: string) => db.prepare('SELECT offer FROM scan_jobs WHERE id = ?').pluck().get(job)
  const post = (id: string, value: string) => POST(new NextRequest(`http://localhost/api/campaigns/${id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost', host: 'localhost' },
    body: JSON.stringify({ offer: value }),
  }), { params: Promise.resolve({ id }) })

  setUser(a.user)
  const aOffer = 'Commercial vehicle maintenance for fleet operators'
  assert.equal((await post(a.job, aOffer)).status, 200)
  assert.equal(offer(a.job), aOffer)

  setUser(b.user)
  const bOffer = 'Inventory tools for independent bookstores'
  const foreign = await post(a.job, bOffer)
  const missing = await post(randomBytes(12).toString('hex'), bOffer)
  assert.equal(foreign.status, 404)
  assert.equal(missing.status, 404)
  assert.equal(foreign.headers.get('content-type'), missing.headers.get('content-type'))
  assert.equal(await foreign.text(), await missing.text())
  assert.equal(offer(a.job), aOffer)

  assert.equal((await post(b.job, bOffer)).status, 200)
  assert.equal(offer(b.job), bOffer)
  assert.equal(offer(a.job), aOffer)
})
