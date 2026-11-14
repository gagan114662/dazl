import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { sqliteDb } from '../lib/db/client.ts'
import { migrateAuth } from '../lib/auth-db.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migratePreviewClaim, issuePreviewClaim, verifyClaimToken, readPublicClaim, claimPreview, readClaimedPreview } from '../lib/scan/preview-claim.ts'

// Synthetic runs, companies and people only.
const NOW = Date.UTC(2026, 9, 31)
const master = randomBytes(32)
const OFFER = { text: 'Appointment reminders for physiotherapy clinics', sourceUrl: 'https://prospect-clinicsoft.test/about' }

function setup() {
  const h = new Database(':memory:')
  migrateAuth(h); migrateScan(h); migrateConnectors(h); migratePreviewClaim(h)   // lead_enrichments: the preview reads the required-check marker
  const db = sqliteDb(h)
  const jobId = createJob(h, 'seller1', { business_name: 'Seller Co', industry: 'x', location: 'y' })
  const day = new Date(NOW - 10 * 86400_000).toISOString().slice(0, 10)
  h.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(jobId)
  h.prepare("UPDATE scan_jobs SET seller = ? WHERE id = ?").run(`${OFFER.text} - ${OFFER.sourceUrl}`, jobId)
  return { h, db, jobId, day }
}
const lead = (h: Database.Database, jobId: string, id: string, day: string) => h.prepare(
  'INSERT INTO leads (id, scan_job_id, company, signal, source_url, evidence_excerpt, confidence, score, event_date, date_status, event_date_proof) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  .run(id, jobId, 'Northside Physio', 'Opened a second clinic', 'https://news.test/a1', 'We opened our second clinic this month.', 80, 70, day, 'unverified', 'page_bound')
const finish = (h: Database.Database, jobId: string) => h.prepare("UPDATE scan_jobs SET status = 'done', finished_at = ? WHERE id = ?").run(NOW, jobId)
const user = (h: Database.Database, id: string, email: string, verified: boolean) =>
  h.prepare('INSERT INTO users (id, email, name, business_name, password_hash, salt, created_at, email_verified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, email, 'P', 'B', 'h', 's', NOW, verified ? NOW : null)

const ISSUE = (jobId: string, email = 'Prospect@Clinic.test') => ({ runId: jobId, sellerTenantId: 'seller1', recipientEmail: email, business: 'Clinic Soft' })

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
  const got = await readClaimedPreview(db, 't-prospect', r.id, NOW)
  assert.ok(got && !('expired' in got))
  if (got && !('expired' in got)) assert.equal(got.snapshot.companies[0].company, 'Northside Physio')
  assert.equal(await readClaimedPreview(db, 'seller1', r.id, NOW), null, 'even the seller\u2019s tenant has no read')
  assert.equal(await readClaimedPreview(db, 't-prospect', '0'.repeat(32), NOW), null)
  assert.equal(await readClaimedPreview(db, 't-prospect', 'not-an-id', NOW), null)
  assert.deepEqual(await readClaimedPreview(db, 't-prospect', r.id, NOW + 91 * 86400_000), { expired: true }, 'private view expires with the evidence, like the public one')
})

// #403: the same proof issued again is the same claim (cached); a changed proof is a new version
test('issue: repeating the same proof for the same recipient returns the open claim, never a second live link', async () => {
  const { h, db, jobId, day } = setup()
  lead(h, jobId, 'l1', day)
  finish(h, jobId)
  const a = await issuePreviewClaim(db, master, ISSUE(jobId), NOW)
  const b = await issuePreviewClaim(db, master, ISSUE(jobId, 'PROSPECT@clinic.test'), NOW + 5000)
  if (!a || a.status !== 'issued' || !b || b.status !== 'issued') throw new Error('setup')
  assert.deepEqual([b.id, b.token, b.expiresAt], [a.id, a.token, a.expiresAt], 'replay: same claim, same link')
  assert.equal((h.prepare('SELECT count(*) AS n FROM preview_claims').get() as { n: number }).n, 1)
  const snap = JSON.parse((h.prepare('SELECT snapshot FROM preview_claims WHERE id = ?').get(a.id) as { snapshot: string }).snapshot)
  assert.equal(snap.version, 1, 'the snapshot names the builder version it was made under')
  // another business name, or another recipient, is its own claim
  const c = await issuePreviewClaim(db, master, { ...ISSUE(jobId), business: 'Other Co' }, NOW)
  const d = await issuePreviewClaim(db, master, ISSUE(jobId, 'second@clinic.test'), NOW)
  assert.ok(c?.status === 'issued' && d?.status === 'issued' && new Set([a.id, c.id, d.id]).size === 3)
  // a changed proof (the lead's event text was corrected after the run) is a new version with its own claim
  h.prepare("UPDATE leads SET signal = 'Opened a third clinic' WHERE id = 'l1'").run()
  const e = await issuePreviewClaim(db, master, ISSUE(jobId), NOW)
  assert.ok(e?.status === 'issued' && e.id !== a.id)
  // a claimed one is never handed out again
  user(h, 'u1', 'prospect@clinic.test', true)
  if (e?.status === 'issued') assert.equal((await claimPreview(db, master, e.token, { actorId: 'u1', tenantId: 't-p' }, NOW)).status, 'claimed')
  const f = await issuePreviewClaim(db, master, ISSUE(jobId), NOW)
  assert.ok(f?.status === 'issued' && f.id !== e?.id)
})

// #403: evidence withdrawn after issue is never served from the frozen snapshot
test('withdrawn evidence: a quarantined, purged, re-reviewed or deleted lead withdraws the preview everywhere', async () => {
  for (const withdraw of [
    (h: Database.Database) => h.prepare('UPDATE leads SET quarantined_at = 1').run(),
    (h: Database.Database) => h.prepare('UPDATE leads SET evidence_purged_at = 1').run(),
    (h: Database.Database) => h.prepare("UPDATE leads SET review_reason = 'contradicted'").run(),
    (h: Database.Database) => h.prepare('DELETE FROM leads').run(),
    (h: Database.Database) => h.prepare("UPDATE leads SET source_url = 'https://news.test/moved'").run(),
    (h: Database.Database) => h.prepare("UPDATE scan_jobs SET user_id = 'someone-else'").run(),
    (h: Database.Database) => h.prepare("UPDATE preview_claims SET snapshot = 'not json'").run(),
    (h: Database.Database) => h.prepare('UPDATE preview_claims SET snapshot = ?').run(JSON.stringify({ runId: 'x', companies: 'nope' })),
    (h: Database.Database) => h.prepare('UPDATE preview_claims SET snapshot = ?').run(JSON.stringify({ runId: 'x', companies: [] })),
    (h: Database.Database) => h.prepare('UPDATE preview_claims SET snapshot = ?').run(JSON.stringify({ runId: 'x', companies: [{ company: 'A', sourceUrl: 42 }] })),
    (h: Database.Database) => h.prepare('UPDATE preview_claims SET snapshot = ?').run('null'),
    (h: Database.Database) => h.prepare('UPDATE preview_claims SET snapshot = ?').run('[]'),
    (h: Database.Database) => h.prepare('UPDATE preview_claims SET snapshot = ?').run('x'.repeat(200_000)),
    (h: Database.Database) => { const r = h.prepare('SELECT snapshot FROM preview_claims').get() as { snapshot: string }; const v = JSON.parse(r.snapshot); delete v.offer; h.prepare('UPDATE preview_claims SET snapshot = ?').run(JSON.stringify(v)) },
    (h: Database.Database) => { const r = h.prepare('SELECT snapshot FROM preview_claims').get() as { snapshot: string }; const v = JSON.parse(r.snapshot); v.companies[0].quote = null; h.prepare('UPDATE preview_claims SET snapshot = ?').run(JSON.stringify(v)) },
    (h: Database.Database) => h.prepare('UPDATE preview_claims SET snapshot = ?').run(Buffer.from([0xff, 0xfe, 0x7b]).toString('latin1')),
  ]) {
    const { h, db, jobId, day } = setup()
    lead(h, jobId, 'l1', day)
    finish(h, jobId)
    const r = await issuePreviewClaim(db, master, ISSUE(jobId), NOW)
    if (!r || r.status !== 'issued') throw new Error('setup')
    assert.equal((await readPublicClaim(db, master, r.token, NOW)).status, 'ok')
    withdraw(h)
    assert.equal((await readPublicClaim(db, master, r.token, NOW)).status, 'expired', String(withdraw))
    user(h, 'u1', 'prospect@clinic.test', true)
    assert.equal((await claimPreview(db, master, r.token, { actorId: 'u1', tenantId: 't-p' }, NOW)).status, 'expired', 'nothing withdrawn can be claimed')
    const ev = h.prepare('SELECT outcome FROM preview_claim_events WHERE claim_id = ?').all(r.id) as { outcome: string }[]
    assert.deepEqual(ev.map(e => e.outcome), ['expired'], 'the refused attempt is still recorded')
  }
})

test('withdrawn evidence after claiming: the private route reads expired too', async () => {
  const { h, db, jobId, day } = setup()
  lead(h, jobId, 'l1', day)
  finish(h, jobId)
  const r = await issuePreviewClaim(db, master, ISSUE(jobId), NOW)
  if (!r || r.status !== 'issued') throw new Error('setup')
  user(h, 'u1', 'prospect@clinic.test', true)
  assert.equal((await claimPreview(db, master, r.token, { actorId: 'u1', tenantId: 't-p' }, NOW)).status, 'claimed')
  h.prepare('UPDATE leads SET quarantined_at = 1').run()
  assert.deepEqual(await readClaimedPreview(db, 't-p', r.id, NOW), { expired: true })
})

test('issue: a Postgres serialization conflict retries a bounded number of times; other errors and endless conflicts throw', async () => {
  const { h, db, jobId, day } = setup()
  lead(h, jobId, 'l1', day)
  finish(h, jobId)
  const conflict = () => Object.assign(new Error('could not serialize access'), { code: '40001' })
  const flaky = (fails: number, err: () => Error = conflict) => { let n = 0; return { ...db, tx: ((b: never, i: never) => n++ < fails ? Promise.reject(err()) : db.tx(b, i)) as typeof db.tx } }
  const r = await issuePreviewClaim(flaky(2), master, ISSUE(jobId), NOW)
  assert.ok(r?.status === 'issued' && !r.reused)
  const nested = () => Object.assign(new Error('tx failed'), { cause: { code: '40P01' } })
  const again = await issuePreviewClaim(flaky(1, nested), master, ISSUE(jobId), NOW)
  assert.ok(again?.status === 'issued' && again.reused && again.id === r.id, 'after the conflict it finds the winner\u2019s claim')
  await assert.rejects(issuePreviewClaim(flaky(99), master, ISSUE(jobId, 'x@clinic.test'), NOW), /serialize/)
  await assert.rejects(issuePreviewClaim(flaky(1, () => new Error('disk full')), master, ISSUE(jobId, 'y@clinic.test'), NOW), /disk full/)
  assert.equal((h.prepare('SELECT count(*) AS n FROM preview_claims').get() as { n: number }).n, 1, 'no failed attempt left a row')
})
