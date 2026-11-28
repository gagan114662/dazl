import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { sqliteDb } from '../../lib/db/client.ts'
import { migrateSmtpMailboxes, saveSmtpMailbox } from '../../lib/email/smtp-store.ts'
import { DELETE, GET, PUT } from '../../app/api/settings/smtp/route.ts'

test('SMTP settings rejects unauthorized writes before verification and returns only workspace status', async () => {
  const raw = new Database(':memory:')
  try {
    raw.exec("CREATE TABLE users (id TEXT PRIMARY KEY); INSERT INTO users VALUES ('a'), ('b')")
    migrateSmtpMailboxes(raw)
    setScanDb(raw)
    const input = { host: 'relay.example.net', port: 465, username: 'owner@example.net', password: 'fixture secret' }
    const request = (origin = 'http://localhost', body: unknown = input) => new NextRequest('http://localhost/api/settings/smtp', {
      method: 'PUT', headers: { 'content-type': 'application/json', origin, host: 'localhost' }, body: JSON.stringify(body),
    })
    setUser(null)
    assert.equal((await PUT(request())).status, 401)
    setUser({ id: 'a', business_name: 'Owner', authedAt: 0 })
    assert.equal((await PUT(request())).status, 403)
    setUser({ id: 'a', business_name: 'Owner' })
    assert.equal((await PUT(request('http://foreign.example'))).status, 400)
    assert.equal((await PUT(request('http://localhost', { ...input, port: 25 }))).status, 400)
    assert.deepEqual(await (await GET()).json(), { mailbox: null })
    const id = await saveSmtpMailbox(sqliteDb(raw), 'a', input, Buffer.alloc(32, 3))
    assert.deepEqual(await (await GET()).json(), { mailbox: { id, host: input.host, port: input.port, username: input.username } })
    setUser({ id: 'b', business_name: 'Other workspace' })
    assert.deepEqual(await (await GET()).json(), { mailbox: null })
    const disconnect = (connectionId: string, origin = 'http://localhost') => DELETE(new NextRequest('http://localhost/api/settings/smtp', {
      method: 'DELETE', headers: { 'content-type': 'application/json', origin, host: 'localhost' },
      body: JSON.stringify({ id: connectionId }),
    }))
    assert.equal((await disconnect(id)).status, 409)
    setUser({ id: 'a', business_name: 'Owner' })
    assert.equal((await disconnect(id, 'http://foreign.example')).status, 400)
    const replacement = await saveSmtpMailbox(sqliteDb(raw), 'a', input, Buffer.alloc(32, 3))
    assert.equal((await disconnect(id)).status, 409)
    assert.equal((await disconnect(replacement)).status, 200)
    assert.deepEqual(await (await GET()).json(), { mailbox: null })

  } finally {
    raw.close()
  }
})
