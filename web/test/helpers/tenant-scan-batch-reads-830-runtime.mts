import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import test from 'node:test'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { GET as csv, POST as resumeCsv } from '../../app/api/scan/csv/[batch]/route.ts'
import { GET as commenters, DELETE as deleteCommenters } from '../../app/api/scan/commenters/[batch]/route.ts'
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
    const get = async (batch: string) => {
      const response = await read(new NextRequest('http://localhost'), { params: Promise.resolve({ batch }) })
      assert.ok(response)
      return response
    }

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

    const resume = name === 'CSV'
    const action = async (batch: string) => {
      const response = await (resume ? resumeCsv : deleteCommenters)(new NextRequest('http://localhost', {
        method: resume ? 'POST' : 'DELETE',
        headers: { 'content-type': 'application/json', origin: 'http://localhost', host: 'localhost' },
        body: '{}',
      }), { params: Promise.resolve({ batch }) })
      assert.ok(response)
      return response
    }
    const storedBatches = () => [
      db.prepare('SELECT * FROM csv_batches ORDER BY id').all(),
      db.prepare('SELECT * FROM commenter_batches ORDER BY id').all(),
    ]
    const before = storedBatches()
    setUser(b.user)
    const foreignAction = await action(a.batch)
    const missingAction = await action(id())
    assert.equal(foreignAction.status, 404)
    assert.equal(missingAction.status, 404)
    assert.equal(foreignAction.headers.get('content-type'), missingAction.headers.get('content-type'))
    assert.equal(await foreignAction.text(), await missingAction.text())
    assert.deepEqual(storedBatches(), before)

    const ownerAction = await action(b.batch)
    if (resume) {
      assert.equal(ownerAction.status, 402)
      assert.deepEqual(await ownerAction.json(), { error: 'pro_only' })
      assert.deepEqual(storedBatches(), before)
    } else {
      assert.equal(ownerAction.status, 200)
      assert.deepEqual(await ownerAction.json(), { ok: true })
      assert.equal((await get(b.batch)).status, 404)
    }
    setUser(a.user)
    const untouched = await get(a.batch)
    assert.equal(untouched.status, 200)
    assert.equal((await untouched.json()).note, a.note)
  })
}
