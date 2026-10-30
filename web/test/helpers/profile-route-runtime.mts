// Runs the REAL /api/settings/profile GET and POST handlers against a real (temporary) SQLite auth database.
// Only the session lookup is replaced (tenant-route-db.ts). No network: fetch throws.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { NextRequest } from 'next/server'
import { setUser } from './tenant-route-db.ts'

globalThis.fetch = (async () => { throw new Error('Unexpected network call') }) as typeof fetch
const dir = mkdtempSync(path.join(tmpdir(), 'dazl-profile-'))
process.env.DB_PATH = path.join(dir, 'app.db')
const { getAuthDb } = await import('../../lib/auth-db.ts')
const route = await import('../../app/api/settings/profile/route.ts')
const db = getAuthDb()
for (const id of ['A', 'B']) db.prepare("INSERT INTO users (id, email, password_hash, salt) VALUES (?, ?, 'x', 'y')").run(id, `${id}@example.test`)
const as = (id: string) => setUser({ id, business_name: '' })
const post = (body: unknown) => route.POST(new NextRequest('http://localhost/api/settings/profile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
const get = async () => (await route.GET()).json()

const BUYER = { summary: 'ONLY independent New York City clinics with 2-5 locations', who: ['Clinic administrators'], industries: ['Healthcare clinics'], sizes: ['2-5 locations'], where: ['New York City'], signals: ['Opened a new location within past 30 days'], exclude: ['Chains'] }

test('the reviewed buyer profile is saved, survives a fresh read (reload) and stays with its tenant', async () => {
  as('A')
  const r = await post({ sells: 'Front-desk software for clinics', website: 'https://clinicdesk.example', business_name: 'ClinicDesk', buyer: BUYER })
  assert.equal(r.status, 200)
  assert.deepEqual((await r.json()).buyer, BUYER, 'the response is what was stored')
  assert.deepEqual(await get(), { sells: 'Front-desk software for clinics', website: 'https://clinicdesk.example', business_name: 'ClinicDesk', buyer: BUYER })
  // A reload is a fresh GET; also read the row itself so this is not just an in-memory echo.
  assert.deepEqual(JSON.parse((db.prepare('SELECT buyer_profile FROM users WHERE id = ?').get('A') as { buyer_profile: string }).buyer_profile), BUYER)
  as('B')
  assert.equal((await get()).buyer, null, "another tenant never sees A's profile")
})

test('omitting buyer keeps it, null clears it, an invalid one is refused and changes nothing', async () => {
  as('A')
  assert.equal((await post({ business_name: 'ClinicDesk Inc' })).status, 200)
  assert.deepEqual((await get()).buyer, BUYER, 'a name-only save keeps the buyer profile')
  const bad = await post({ buyer: { who: ['x'] } })
  assert.equal(bad.status, 400)
  assert.deepEqual((await get()).buyer, BUYER)
  assert.equal((await post({ buyer: 'nope' })).status, 400)
  assert.equal((await post({ buyer: null })).status, 200)
  assert.equal((await get()).buyer, null)
})

test('fields outside the profile are dropped and values are capped by the same validation as a scan profile', async () => {
  as('B')
  const r = await post({ buyer: { ...BUYER, injected: 'x', who: Array(20).fill('Owner') } })
  const saved = (await r.json()).buyer
  assert.equal('injected' in saved, false)
  assert.ok(saved.who.length < 20)
  rmSync(dir, { recursive: true, force: true })
})
