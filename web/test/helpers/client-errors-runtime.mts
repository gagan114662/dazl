// The real app/api/client-errors route (see test/client-errors.test.ts) on a throwaway SQLite store.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setDb, sqliteDb } from '../../lib/db/client.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { createSession } from '../../lib/auth-db.ts'
import { setErrorSinks, type ErrorRecord } from '../../lib/ops/errors.ts'

const route = await import('../../app/api/client-errors/route.ts')
const T = 'd'.repeat(32)

test('client error endpoint', async () => {
  const raw = new Database(':memory:'); migrateAllSqlite(raw)
  const db = sqliteDb(raw); setDb(db)
  raw.prepare("INSERT INTO users (id, email, business_name, password_hash, salt) VALUES (?, 'owner@example.test', 'Acme', 'h', 's')").run(T)
  const token = await createSession(T, db)
  const got: ErrorRecord[] = []
  const restore = setErrorSinks([r => got.push(r)])
  const report = { kind: 'error', type: 'TypeError', frames: [{ file: '/_next/static/a.js', line: 1, col: 2 }], path: '/app/leads', tenant: 'e'.repeat(32), message: 'Priya Venkataraman q7Rk2mZp9XwB4vNf8LtY3sHd6JcE1aUo' }
  const post = (body: string | ReadableStream, h: Record<string, string> = {}, ip = '203.0.113.9') => route.POST(new NextRequest('https://dazl.test/api/client-errors', {
    method: 'POST', body, headers: { 'content-type': 'application/json', host: 'dazl.test', origin: 'https://dazl.test', 'x-forwarded-for': ip, ...h }, ...(typeof body === 'string' ? {} : { duplex: 'half' }) } as unknown as ConstructorParameters<typeof NextRequest>[1]))
  try {
    assert.equal((await post(JSON.stringify(report), { cookie: `dazl_session=${token}` })).status, 204)
    assert.equal((await post(JSON.stringify(report))).status, 204) // signed out: recorded without a tenant
    assert.deepEqual(got.map(g => [g.source, g.where, g.tenant]), [['client', 'error:/app/leads', T], ['client', 'error:/app/leads', null]], 'tenant from the session, never the body')
    assert.equal((await post(JSON.stringify(report), { origin: 'https://evil.example' })).status, 403)
    assert.equal((await post(JSON.stringify(report), { origin: '' })).status, 403)
    assert.equal((await post(JSON.stringify(report), { origin: 'not a url' })).status, 403)
    assert.ok(!JSON.stringify(got).includes('Priya') && !JSON.stringify(got).includes('q7Rk2m'), 'a message field is never recorded')
    // size: a declared length over 4 KB is refused before reading; an undeclared one stops being read past 4 KB
    assert.equal((await post(JSON.stringify({ ...report, pad: 'x'.repeat(5000) }))).status, 413)
    assert.equal((await post(JSON.stringify(report), { 'content-length': '999999' })).status, 413, 'declared too large: refused unread')
    // review repro: 3000 x '界' is 9166 UTF-8 bytes but only 3166 JS characters; the cap is on bytes
    const wide = JSON.stringify({ ...report, message: '界'.repeat(3000) })
    assert.ok(Buffer.byteLength(wide) > 9000 && wide.length < 4096)
    assert.equal((await post(wide)).status, 413, 'multibyte body over the byte cap')
    const wideStream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(wide)); c.close() } })
    assert.equal((await post(wideStream)).status, 413, 'the same, chunked with no declared length')
    let pulled = 0
    const endless = new ReadableStream({ pull(c) { pulled++; c.enqueue(new TextEncoder().encode('x'.repeat(1024))); if (pulled > 1000) c.close() } })
    assert.equal((await post(endless)).status, 413)
    assert.ok(pulled < 20, `stopped reading early (${pulled} KB pulled)`)
    assert.equal((await post('{not json')).status, 400)
    assert.equal((await post(JSON.stringify({ kind: 'nope', path: '/app' }))).status, 400)
    assert.equal(got.length, 2, 'refused reports record nothing')
    // 30 per IP per 10 minutes, counted in the shared rate_limits table
    const codes: number[] = []
    for (let i = 0; i < 32; i++) codes.push((await post(JSON.stringify(report), {}, '198.51.100.7')).status)
    assert.deepEqual([codes.filter(c => c === 204).length, codes.at(-1)], [30, 429])
  } finally { restore(); raw.close() }
  console.log('CLIENT_ERRORS_ROUTE_OK')
})
