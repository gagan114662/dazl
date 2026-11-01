import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { sqliteDb } from '../lib/db/client.ts'
import { migrateAuth } from '../lib/auth-db.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migratePreviewClaim, issuePreviewClaim, verifyClaimToken, readPublicClaim, claimPreview, readClaimedPreview } from '../lib/scan/preview-claim.ts'

// Synthetic runs, companies and people only.
const NOW = Date.UTC(2026, 9, 31)
const master = randomBytes(32)
const OFFER = { text: 'Appointment reminders for physiotherapy clinics', sourceUrl: 'https://prospect-clinicsoft.test/about' }

function setup() {
  const h = new Database(':memory:')
  migrateAuth(h); migrateScan(h); migratePreviewClaim(h)
  const db = sqliteDb(h)
  const jobId = createJob(h, 'seller1', { business_name: 'Seller Co', industry: 'x', location: 'y' })
  const day = new Date(NOW - 10 * 86400_000).toISOString().slice(0, 10)
  h.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(jobId)
  return { h, db, jobId, day }
}
const lead = (h: Database.Database, jobId: string, id: string, day: string) => h.prepare(
  'INSERT INTO leads (id, scan_job_id, company, signal, source_url, evidence_excerpt, confidence, score, event_date, date_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  .run(id, jobId, 'Northside Physio', 'Opened a second clinic', 'https://news.test/a1', 'We opened our second clinic this month.', 80, 70, day, 'verified')
const finish = (h: Database.Database, jobId: string) => h.prepare("UPDATE scan_jobs SET status = 'done', finished_at = ? WHERE id = ?").run(NOW, jobId)
const user = (h: Database.Database, id: string, email: string, verified: boolean) =>
  h.prepare('INSERT INTO users (id, email, name, business_name, password_hash, salt, created_at, email_verified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, email, 'P', 'B', 'h', 's', NOW, verified ? NOW : null)

const ISSUE = (jobId: string, email = 'Prospect@Clinic.test') => ({ runId: jobId, sellerTenantId: 'seller1', recipientEmail: email, business: 'Clinic Soft', inferredOffer: OFFER, spendUsd: 0.42 })

test('issue: only a ready preview gets a claim; the stored snapshot is the stripped artifact (no spend, no contacts)', async () => {
  const { h, db, jobId, day } = setup()
  lead(h, jobId, 'l1', day)
  finish(h, jobId)
  const r = await issuePreviewClaim(db, master, ISSUE(jobId), NOW)
  if (!r || r.status !== 'issued') { assert.fail('expected issued, got ' + JSON.stringify(r)) }
  const row = h.prepare('SELECT * FROM preview_claims WHERE id = ?').get(r.id) as Record<string, unknown>
  assert.equal(row.recipient_email, 'prospect@clinic.test', 'recipient stored normalized')
  assert.equal(row.seller_tenant_id, 'seller1')
  assert.equal(row.expires_at, Date.parse(day) + 90 * 86400_000, 'expiry is the evidence expiry, not an invented default')
  const snap = JSON.parse(String(row.snapshot))
  assert.equal('spendUsd' in snap, false, 'spend never leaves the seller')
  assert.equal(snap.companies.length, 1)
  assert.equal(snap.offer.inferred, true)
  assert.ok(!/@/.test(JSON.stringify(snap)), 'no email-shaped string in the served artifact')
})

test('issue: a hold (no usable results) stores nothing, so no invented success gets a link', async () => {
  const { h, db, jobId } = setup()
  finish(h, jobId)
  const r = await issuePreviewClaim(db, master, ISSUE(jobId), NOW)
  assert.deepEqual(r, { status: 'hold', reason: 'no_usable_results' })
  assert.equal((h.prepare('SELECT count(*) AS n FROM preview_claims').get() as { n: number }).n, 0)
  assert.equal(await issuePreviewClaim(db, master, { ...ISSUE('missing-run'), runId: 'missing-run' }, NOW), null, 'another tenant\u2019s run id is not found')
  assert.equal(await issuePreviewClaim(db, master, ISSUE(jobId, 'not-an-email'), NOW), null)
})

test('token: malformed or tampered tokens never name a row', async () => {
  const { h, db, jobId, day } = setup()
  lead(h, jobId, 'l1', day)
  finish(h, jobId)
  const r = await issuePreviewClaim(db, master, ISSUE(jobId), NOW)
  if (!r || r.status !== 'issued') throw new Error('setup')
  const [id, sig] = r.token.split('.')
  assert.equal(verifyClaimToken(master, r.token), id)
  assert.equal(verifyClaimToken(master, `${id}.${sig.replace(/.$/, (c: string) => c === 'a' ? 'b' : 'a')}`), null, 'tampered signature')
  assert.equal(verifyClaimToken(master, `${'0'.repeat(32)}.${sig}`), null, 'foreign id signs differently')
  assert.equal(verifyClaimToken(randomBytes(32), r.token), null, 'wrong key')
  assert.equal(verifyClaimToken(master, 'junk'), null)
  assert.equal(verifyClaimToken(master, `${id}.${sig}x`), null)
})

test('public read: live claim serves its snapshot; claimed and expired are terminal with no content', async () => {
  const { h, db, jobId, day } = setup()
  lead(h, jobId, 'l1', day)
  finish(h, jobId)
  const r = await issuePreviewClaim(db, master, ISSUE(jobId), NOW)
  if (!r || r.status !== 'issued') throw new Error('setup')
  const ok = await readPublicClaim(db, master, r.token, NOW)
  assert.equal(ok.status, 'ok')
  if (ok.status === 'ok') assert.equal(ok.snapshot.companies[0].company, 'Northside Physio')
  user(h, 'u1', 'prospect@clinic.test', true)
  const c = await claimPreview(db, master, r.token, { actorId: 'u1', tenantId: 'u1' }, NOW)
  assert.equal(c.status, 'claimed')
  assert.equal((await readPublicClaim(db, master, r.token, NOW)).status, 'claimed', 'public content revoked after claim')
  h.prepare('UPDATE preview_claims SET claimed_by_tenant = NULL, claimed_at = NULL, expires_at = ? WHERE id = ?').run(NOW - 1, r.id)
  assert.equal((await readPublicClaim(db, master, r.token, NOW)).status, 'expired')
  assert.equal((await readPublicClaim(db, master, `${'1'.repeat(32)}.${'2'.repeat(32)}`, NOW)).status, 'unknown')
})

test('claim: exact verified recipient email only, atomic once, idempotent for the claiming workspace', async () => {
  const { h, db, jobId, day } = setup()
  lead(h, jobId, 'l1', day)
  finish(h, jobId)
  const r = await issuePreviewClaim(db, master, ISSUE(jobId), NOW)
  if (!r || r.status !== 'issued') throw new Error('setup')
  user(h, 'u1', 'prospect@clinic.test', false)
  user(h, 'u-other', 'colleague@clinic.test', true)
  assert.equal((await claimPreview(db, master, r.token, { actorId: 'u-other', tenantId: 't-other' }, NOW)).status, 'foreign', 'same domain, wrong email: nothing')
  assert.equal((await claimPreview(db, master, r.token, { actorId: 'u1', tenantId: 't-unv' }, NOW)).status, 'unverified', 'ownership unproven')
  assert.equal((await claimPreview(db, master, r.token, { actorId: 'nobody', tenantId: 't-x' }, NOW)).status, 'foreign')
  h.prepare('UPDATE users SET email_verified_at = ? WHERE id = ?').run(NOW, 'u1') // the verify link lands
  const c = await claimPreview(db, master, r.token, { actorId: 'u1', tenantId: 't-prospect' }, NOW)
  assert.deepEqual(c, { status: 'claimed', id: r.id })
  assert.deepEqual(await claimPreview(db, master, r.token, { actorId: 'u1', tenantId: 't-prospect' }, NOW), { status: 'already', id: r.id }, 'resume after refresh is not a failure')
  assert.equal((await claimPreview(db, master, r.token, { actorId: 'u-other', tenantId: 't-other' }, NOW)).status, 'foreign', 'claimed stays claimed')
  const row = h.prepare('SELECT claimed_by_tenant FROM preview_claims WHERE id = ?').get(r.id) as { claimed_by_tenant: string }
  assert.equal(row.claimed_by_tenant, 't-prospect')
})

test('claim: expired and unknown tokens fail closed', async () => {
  const { h, db, jobId, day } = setup()
  lead(h, jobId, 'l1', day)
  finish(h, jobId)
  const r = await issuePreviewClaim(db, master, ISSUE(jobId), NOW)
  if (!r || r.status !== 'issued') throw new Error('setup')
  user(h, 'u1', 'prospect@clinic.test', true)
  h.prepare('UPDATE preview_claims SET expires_at = ? WHERE id = ?').run(NOW - 1, r.id)
  assert.equal((await claimPreview(db, master, r.token, { actorId: 'u1', tenantId: 't1' }, NOW)).status, 'expired')
  assert.equal((await claimPreview(db, master, 'junk', { actorId: 'u1', tenantId: 't1' }, NOW)).status, 'unknown')
  assert.equal((await claimPreview(db, master, `${'1'.repeat(32)}.${'2'.repeat(32)}`, { actorId: 'u1', tenantId: 't1' }, NOW)).status, 'unknown')
})

test('private route read: only the claiming workspace sees the claimed preview', async () => {
  const { h, db, jobId, day } = setup()
  lead(h, jobId, 'l1', day)
  finish(h, jobId)
  const r = await issuePreviewClaim(db, master, ISSUE(jobId), NOW)
  if (!r || r.status !== 'issued') throw new Error('setup')
  user(h, 'u1', 'prospect@clinic.test', true)
  await claimPreview(db, master, r.token, { actorId: 'u1', tenantId: 't-prospect' }, NOW)
  const got = await readClaimedPreview(db, 't-prospect', r.id)
  assert.equal(got?.snapshot.companies[0].company, 'Northside Physio')
  assert.equal(await readClaimedPreview(db, 'seller1', r.id), null, 'even the seller\u2019s tenant has no read')
  assert.equal(await readClaimedPreview(db, 't-prospect', '0'.repeat(32)), null)
  assert.equal(await readClaimedPreview(db, 't-prospect', 'not-an-id'), null)
})
