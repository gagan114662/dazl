// #1673: the preview confirmation GET (read-only confirmation details for the claim page) carries the same per-IP
// rate limit the sibling preview routes already have. Runs the REAL route handler against a temporary SQLite
// database with the network fenced: under the limit it still serves the proof, the 20/10min per-IP cap matches
// preview-claim / preview-issue / preview-google, the limit is checked before auth, and another IP is unaffected.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { NextRequest } from 'next/server'

process.env.DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'dazl-claimget-')), 'app.db')
const MASTER = randomBytes(32)
Object.assign(process.env, { PUBLIC_BASE_URL: 'https://app.test', DAZL_MASTER_KEY: MASTER.toString('base64') })

const claimRoute = await import('../../app/api/preview/claim/route.ts')
const { createPasswordUser, createSession } = await import('../../lib/auth-db.ts')
const { getAuthDb } = await import('../../lib/db/sqlite-store.ts')
const { migrateScan, createJob } = await import('../../lib/scan/store.ts')
const { migratePreviewClaim, issuePreviewClaim } = await import('../../lib/scan/preview-claim.ts')
const { migratePlatform } = await import('../../lib/db/platform-tables.ts')
const { sqliteDb } = await import('../../lib/db/client.ts')
const { withJar } = await import('./pg-session-headers.ts')

const NOW = Date.UTC(2026, 9, 31)
const h = getAuthDb()
migrateScan(h); migratePreviewClaim(h); migratePlatform(h)

const issueFor = async (email: string) => {
  const jobId = createJob(h, 'seller1', { business_name: 'Seller Co', industry: 'x', location: 'y' })
  h.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(jobId)
  h.prepare("UPDATE scan_jobs SET seller = ? WHERE id = ?").run('Appointment reminders for physiotherapy clinics - https://prospect-clinicsoft.test/about', jobId)
  const day = new Date(NOW - 10 * 86400_000).toISOString().slice(0, 10)
  h.prepare('INSERT INTO leads (id, scan_job_id, company, signal, source_url, evidence_excerpt, confidence, score, event_date, date_status, event_date_proof) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(randomBytes(6).toString('hex'), jobId, 'Northside Physio', 'Opened a second clinic', 'https://news.test/a1', 'We opened our second clinic this month.', 80, 70, day, 'unverified', 'page_bound')
  h.prepare("UPDATE scan_jobs SET status = 'done', finished_at = ? WHERE id = ?").run(NOW, jobId)
  const r = await issuePreviewClaim(sqliteDb(h), MASTER, { runId: jobId, sellerTenantId: 'seller1', recipientEmail: email, business: 'Clinic Soft' }, NOW)
  if (!r || r.status !== 'issued') throw new Error('setup: ' + JSON.stringify(r))
  return r
}

const get = (session: string | null, token: string, ip: string) => withJar(new Map(session ? [['dazl_session', session]] : []), () =>
  claimRoute.GET(new NextRequest(`https://app.test/api/preview/claim?t=${token}`, { method: 'GET', headers: { host: 'app.test', 'x-forwarded-for': ip } })))

test('#1673: the preview confirmation GET is rate limited like its sibling preview routes', async () => {
  const r0 = await issueFor('buyer@example.test')
  await createPasswordUser({ id: 'B1', email: 'buyer@example.test', name: 'B', business_name: 'B', password_hash: 'h', salt: 's' })
  h.prepare("UPDATE users SET email_verified_at = 1 WHERE id = 'B1'").run() // #357: confirmed accounts only have sessions
  const session = await createSession('B1')
  // under the limit the route still serves the proof
  const first = await get(session, r0.token, '10.9.7.1')
  assert.equal(first.status, 200, 'the first read still works')
  assert.equal((await first.json()).business, 'Clinic Soft')
  // the cap: 20 per 10 minutes per IP, matching preview-claim / preview-issue / preview-google
  for (let i = 0; i < 19; i++) assert.equal((await get(session, r0.token, '10.9.7.1')).status, 200, `call ${i + 2} is still under the cap`)
  const over = await get(session, r0.token, '10.9.7.1')
  assert.equal(over.status, 429, 'the 21st call from one IP is refused')
  assert.equal((await over.json()).code, 'too_many')
  assert.ok(Number(over.headers.get('retry-after')) > 0, 'Retry-After is set')
  // the limit is checked before auth: the same exhausted IP gets the same 429 signed out, never a 401
  assert.equal((await get(null, r0.token, '10.9.7.1')).status, 429)
  // another IP keeps its own budget
  const other = await get(session, r0.token, '10.9.7.2')
  assert.equal(other.status, 200, 'a different IP is unaffected')
  console.log('PREVIEW_CLAIM_GET_RATE_LIMIT_OK')
})

test('#1673: invalid tokens burn the same budget, so repeated guessing is capped too', async () => {
  await createPasswordUser({ id: 'B2', email: 'buyer2@example.test', name: 'B', business_name: 'B', password_hash: 'h', salt: 's' })
  h.prepare("UPDATE users SET email_verified_at = 1 WHERE id = 'B2'").run()
  const session = await createSession('B2')
  const junk = `${'1'.repeat(32)}.${'2'.repeat(32)}`
  for (let i = 0; i < 20; i++) assert.equal((await get(session, junk, '10.9.8.1')).status, 404, `invalid call ${i + 1} still reads as unknown`)
  const over = await get(session, junk, '10.9.8.1')
  assert.equal(over.status, 429, 'the 21st invalid call is refused like the valid ones')
  console.log('PREVIEW_CLAIM_GET_TOKEN_BUDGET_OK')
})
