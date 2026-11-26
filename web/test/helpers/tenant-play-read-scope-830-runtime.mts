import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import test from 'node:test'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { createMonitor } from '../../lib/monitors.ts'
import { sqliteDb } from '../../lib/db/client.ts'
import { GET as monitorDetail } from '../../app/api/monitors/[id]/route.ts'
import { GET as newLeads } from '../../app/api/plays/[kind]/[id]/new/route.ts'
import { GET as runs } from '../../app/api/plays/[kind]/[id]/runs/route.ts'
import { setScanDb, setUser } from './tenant-route-db.ts'

const id = () => randomBytes(12).toString('hex')
const watch = (action: typeof newLeads) => (value: string) =>
  action(new Request('http://localhost'), { params: Promise.resolve({ kind: 'watch', id: value }) })
const monitor = (action: typeof newLeads) => (value: string) =>
  action(new Request('http://localhost'), { params: Promise.resolve({ kind: 'monitor', id: value }) })

for (const [name, kind, read] of [
  ['watch runs', 'watch', watch(runs)],
  ['watch new leads', 'watch', watch(newLeads)],
  ['monitor runs', 'monitor', monitor(runs)],
  ['monitor new leads', 'monitor', monitor(newLeads)],
  ['monitor detail', 'monitor', (value: string) =>
    monitorDetail(new NextRequest('http://localhost'), { params: Promise.resolve({ id: value }) })],
] as const) {
  test(`${name} returns only the session tenant’s resources`, async t => {
    const raw = new Database(':memory:')
    t.after(() => { setUser(null); raw.close() })
    migrateAllSqlite(raw)
    setScanDb(raw)
    const db = sqliteDb(raw)
    const seed = async (userId: string) => {
      if (kind === 'monitor') {
        const result = await createMonitor(db, userId, { query: 'Find recent business openings' })
        assert.ok('id' in result)
        return result.id
      }
      const watchId = id()
      raw.prepare("INSERT INTO watches (id, user_id, query, icp, next_run_at) VALUES (?, ?, ?, '{}', 0)")
        .run(watchId, userId, 'Find recent business openings')
      return watchId
    }
    const a = { id: randomUUID(), business_name: 'First workspace' }
    const b = { id: randomUUID(), business_name: 'Second workspace' }
    const [aId, bId] = [await seed(a.id), await seed(b.id)]

    setUser(a)
    assert.equal((await read(aId)).status, 200)
    setUser(b)
    assert.equal((await read(bId)).status, 200)
    const unknown = await read(id())
    const denied = await read(aId)
    assert.equal(unknown.status, 404)
    assert.equal(denied.status, 404)
    assert.equal(denied.headers.get('content-type'), unknown.headers.get('content-type'))
    assert.deepEqual(await denied.json(), await unknown.json())
  })
}
