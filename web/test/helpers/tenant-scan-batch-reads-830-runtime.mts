import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import test from 'node:test'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { GET as csv } from '../../app/api/scan/csv/[batch]/route.ts'
import { GET as commenters } from '../../app/api/scan/commenters/[batch]/route.ts'
import { setScanDb, setUser } from './tenant-route-db.ts'

const id = () => randomBytes(12).toString('hex')
for (const [name, read, insert] of [
  ['CSV', csv, 'INSERT INTO csv_batches (id, user_id, note, total) VALUES (?, ?, ?, 0)'],
  ['Commenter', commenters, "INSERT INTO commenter_batches (id, user_id, note, total, context) VALUES (?, ?, ?, 0, 'Fixture')"],
] as const) {
  test(`${name} batch read requires workspace ownership`, async t => {
    const db = new Database(':memory:')
    t.after(() => { setUser(null); db.close() })
    migrateAllSqlite(db)
    setScanDb(db)
    const seed = (business_name: string) => {
      const user = { id: randomUUID(), business_name }
      const batch = id()
      const note = randomUUID()
      db.prepare(insert).run(batch, user.id, note)
      return { user, batch, note }
    }
    const a = seed('First workspace')
    const b = seed('Second workspace')
    const get = (batch: string) =>
      read(new NextRequest('http://localhost'), { params: Promise.resolve({ batch }) })

    for (const [owner, other] of [[a, b], [b, a]]) {
      setUser(owner.user)
      const own = await get(owner.batch)
      assert.equal(own.status, 200)
      const body = await own.json()
      assert.equal(body.batch_id, owner.batch)
      assert.equal(body.note, owner.note)
      const foreign = await get(other.batch)
      const missing = await get(id())
      assert.equal(foreign.status, 404)
      assert.equal(missing.status, 404)
      assert.equal(foreign.headers.get('content-type'), missing.headers.get('content-type'))
      assert.deepEqual(await foreign.json(), await missing.json())
    }
  })
}
