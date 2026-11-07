// PR #959 / #931: reply-reading consent lifecycle through the REAL /api/outreach/replies route (stubbed session, in-memory
// store, no network, no mailbox). The panel decides what to show from GET alone (replyReadingState), so each step reads
// GET again, which is exactly the reload the component performs after every action and on a page reload.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { actionMessage, replyReadingState, type RepliesViewInput } from '../../lib/outreach/replies-view.ts'

globalThis.fetch = (async (u: unknown) => { throw new Error(`Unexpected network call ${String(u)}`) }) as typeof fetch
const raw = new Database(':memory:'); migrateAllSqlite(raw); setScanDb(raw)
const { GET, POST } = await import('../../app/api/outreach/replies/route.ts')

type Info = RepliesViewInput & { consent: { version: string; accepted: boolean }; bounce_scan: { version: string; accepted: boolean }; read_granted: boolean; gmail_connected: boolean }
const as = (tenant: string) => setUser({ id: tenant, business_name: 'Test Co' })
let ip = 0
const post = (body: unknown, headers: Record<string, string> = { origin: 'http://localhost' }) => POST(new NextRequest('http://localhost/api/outreach/replies', {
  method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost', 'x-forwarded-for': `10.9.0.${++ip}`, ...headers }, body: JSON.stringify(body) }))
const info = async () => { const r = await GET(); assert.equal(r.status, 200); return await r.json() as Info }
const state = async () => replyReadingState(await info())
const connect = (tenant: string, o: { status?: string; read?: number } = {}) => raw.prepare("INSERT OR REPLACE INTO gmail_accounts (tenant_id, email, refresh_ct, status, read_granted) VALUES (?, 'qa@example.test', 'ct', ?, ?)").run(tenant, o.status ?? 'active', o.read ?? 1)

test('lifecycle: disconnected -> consent needed -> accepted (on) -> revoked (consent needed, still connected) -> re-accepted, each seen after a reload', async () => {
  as('t1')
  assert.equal(await state(), 'disconnected')
  connect('t1')
  assert.equal(await state(), 'consent_needed', 'connected with the read scope but no accepted consent')
  const v = (await info()).consent.version
  let r = await post({ action: 'consent', accept: true, version: 'stale-version' })
  assert.equal(r.status, 400); assert.equal(((await r.json()) as { error: string }).error, 'Consent not recorded')
  assert.equal(await state(), 'consent_needed', 'a refused accept changes nothing')
  r = await post({ action: 'consent', accept: false, version: v }); assert.equal(r.status, 400, 'accept must be true')
  r = await post({ action: 'consent', accept: true, version: v }); assert.equal(r.status, 200)
  assert.equal(await state(), 'on'); assert.equal(await state(), 'on', 'reload keeps it on')
  r = await post({ action: 'revoke' }); assert.equal(r.status, 200)
  const after = await info()
  assert.equal(replyReadingState(after), 'consent_needed', 'revoked: not on, offers re-acceptance without a reconnect')
  assert.deepEqual([after.gmail_connected, after.read_granted, after.consent.accepted], [true, true, false], 'Gmail stays connected with its read scope')
  assert.equal(await state(), 'consent_needed', 'revoke survives a reload')
  r = await post({ action: 'revoke' }); assert.equal(r.status, 200); assert.equal(await state(), 'consent_needed', 'revoking twice is harmless')
  await post({ action: 'consent', accept: true, version: v }); assert.equal(await state(), 'on', 'accepting the current version turns it back on with no reconnect')
})

test('lifecycle: bounce-scan consent is separate from reply-reading consent in both directions', async () => {
  as('t2'); connect('t2')
  const i0 = await info()
  assert.equal((await post({ action: 'bounce_scan_on', accept: true, version: 'stale' })).status, 400)
  assert.equal((await post({ action: 'bounce_scan_on', accept: true, version: i0.bounce_scan.version })).status, 200)
  let i = await info(); assert.deepEqual([i.bounce_scan.accepted, i.consent.accepted, replyReadingState(i)], [true, false, 'consent_needed'], 'turning the scan on does not turn reply reading on')
  await post({ action: 'consent', accept: true, version: i.consent.version }); assert.equal(await state(), 'on')
  await post({ action: 'revoke' })
  i = await info(); assert.deepEqual([i.bounce_scan.accepted, i.consent.accepted], [true, false], 'revoking reply reading leaves the scan consent alone')
  await post({ action: 'bounce_scan_off' }); i = await info(); assert.deepEqual([i.bounce_scan.accepted, i.consent.accepted], [false, false])
})

test('lifecycle: read scope missing and a needs_reconnect account are distinct states, and consent never papers over them', async () => {
  as('t3'); connect('t3', { read: 0 })
  assert.equal(await state(), 'read_scope_missing')
  const v = (await info()).consent.version
  await post({ action: 'consent', accept: true, version: v })
  assert.equal(await state(), 'read_scope_missing', 'accepted consent without the Gmail read scope is still not on')
  connect('t3', { status: 'needs_reconnect', read: 1 })
  const i = await info(); assert.deepEqual([replyReadingState(i), i.gmail_connected], ['needs_reconnect', false])
  connect('t3'); assert.equal(await state(), 'on', 'an active account with read scope and accepted consent is on (positive control)')
})

test('lifecycle: a refused sync says not checked; unauthenticated and cross-site requests change nothing', async () => {
  as('t4'); connect('t4')
  const r = await post({ action: 'sync' }); assert.equal(r.status, 200)
  const refused = await r.json() as { ok: boolean; sync: { error?: string } }
  assert.equal(refused.sync.error, 'reading_not_enabled', 'no consent: the route refuses inside a 200')
  assert.equal(actionMessage('sync', true, refused), 'Replies were not checked: reply reading is off.', 'the panel text for the real route response')
  assert.equal((await post({ action: 'consent', accept: true, version: (await info()).consent.version }, { origin: 'http://evil.example' })).status, 400, 'cross-site POST')
  assert.equal(await state(), 'consent_needed', 'the cross-site accept did not record')
  assert.equal((await post({ action: 'frobnicate' })).status, 400)
  setUser(null)
  assert.equal((await GET()).status, 401); assert.equal((await post({ action: 'revoke' })).status, 401)
  as('t4'); assert.equal(await state(), 'consent_needed', 'the signed-out revoke/consent attempts changed nothing')
  as('t5'); assert.equal(await state(), 'disconnected', 'another tenant sees none of t4')
})
