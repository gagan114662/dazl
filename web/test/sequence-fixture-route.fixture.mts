import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './helpers/tenant-route-db.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { setTestAddresses } from '../lib/outreach/sequences.ts'
import { TEST_INBOX } from '../lib/outreach/service.ts'
import { GET as GET_PRODUCT, POST as POST_PRODUCT } from '../app/api/outreach/sequences/route.ts'
import { GET, POST } from '../app/api/outreach/sequences/fixture/route.staging.ts'

test('staging fixtures stay out of the production sequence route and never approve or send', async () => {
  const db = new Database(':memory:')
  migrateAllSqlite(db)
  setScanDb(db)
  const A = { id: 'a', business_name: 'Fixture' }, B = { id: 'b', business_name: 'Other' }
  const stage = process.env.DAZL_ENV, tenant = process.env.OUTREACH_TEST_TENANT_ID
  const fixed = (action: string, prod = false, origin = 'http://localhost') => (prod ? POST_PRODUCT : POST)(new NextRequest('http://localhost/api/outreach/sequences' + (prod ? '' : '/fixture'), { method: 'POST', headers: { 'content-type': 'application/json', origin, host: 'localhost' }, body: JSON.stringify({ action, tenant_id: A.id }) }))
  try {
    process.env.OUTREACH_TEST_TENANT_ID = A.id
    setTestAddresses(db, A.id, [TEST_INBOX])
    const count = () => (db.prepare('SELECT COUNT(*) AS n FROM outreach_messages').get() as { n: number }).n
    for (const action of ['create_test_fixture', 'create_reply_stop_fixture']) {
      setUser(A)
      process.env.DAZL_ENV = 'production'
      assert.equal((await fixed(action, true)).status, 400)
      assert.equal((await fixed(action)).status, 404)
      assert.equal((await GET()).status, 404)
      assert.equal(count(), action === 'create_test_fixture' ? 0 : 1)
      const prod = await (await GET_PRODUCT()).json()
      assert.equal(prod.test_fixture_available, undefined)
      process.env.DAZL_ENV = 'staging'
      setUser(null)
      assert.equal((await fixed(action)).status, 401)
      setUser({ ...A, role: 'viewer' })
      assert.equal((await fixed(action)).status, 403)
      setUser(B)
      assert.equal((await fixed(action)).status, 400)
      assert.deepEqual(await (await GET()).json(), { available: false })
      setUser(A)
      assert.equal((await fixed(action, false, 'https://invalid.example')).status, 400)
      assert.deepEqual(await (await GET()).json(), { available: true })
      const createdFixture = await fixed(action)
      assert.equal(createdFixture.status, 200)
      assert.equal((await createdFixture.json()).created, true)
    }
    assert.equal(count(), 2)
    assert.deepEqual(db.prepare('SELECT DISTINCT tenant_id,to_email,test,status FROM outreach_messages').all(), [{ tenant_id: A.id, to_email: TEST_INBOX, test: 1, status: 'draft' }])
    assert.deepEqual(db.prepare('SELECT DISTINCT tenant_id,status FROM sequences').all(), [{ tenant_id: A.id, status: 'draft' }])
  } finally {
    if (stage === undefined) delete process.env.DAZL_ENV; else process.env.DAZL_ENV = stage
    if (tenant === undefined) delete process.env.OUTREACH_TEST_TENANT_ID; else process.env.OUTREACH_TEST_TENANT_ID = tenant
    db.close()
  }
})
