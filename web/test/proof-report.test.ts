import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import type { Db } from '../lib/db/client.ts'
import { issuePreviewClaim, proofReport, readPublicClaim, readClaimedPreview, claimPreview, PROOF_SNAPSHOT_VERSION } from '../lib/scan/preview-claim.ts'
import { buildProofPreview, type ProofLeadRow } from '../lib/scan/proof-preview.ts'
import { EXAMPLES } from '../lib/landing-examples.ts'
import { bothEngines } from './helpers/engines.ts'

// #403 evaluation: sample quality, cost and conversion of proof previews, per seller. Synthetic runs and people only.
const NOW = Date.UTC(2026, 10, 3)
const day = (n: number) => new Date(NOW - n * 86400_000).toISOString().slice(0, 10)
const OFFER = { text: 'Appointment reminders for physiotherapy clinics', sourceUrl: 'https://prospect-clinicsoft.test/about' }
const master = randomBytes(32)

async function run(db: Db, tenant: string, o: { leads?: number; spend?: unknown; seller?: string | null } = {}): Promise<string> {
  const id = randomBytes(12).toString('hex')
  await db.run("INSERT INTO scan_jobs (id, user_id, status, business_name, industry, location) VALUES (?, ?, 'pending', 'Synthetic', 'software', 'Toronto')", [id, tenant])
  await db.run("UPDATE scan_jobs SET status = 'running', seller = ? WHERE id = ?", [o.seller === undefined ? `${OFFER.text} - ${OFFER.sourceUrl}` : o.seller, id])
  if (o.spend !== undefined) await db.run('UPDATE scan_jobs SET spend_reserved_usd = ? WHERE id = ?', [o.spend as number, id])
  for (let i = 0; i < (o.leads ?? 1); i++)
    await db.run("INSERT INTO leads (id, scan_job_id, company, signal, source_url, evidence_excerpt, event_date, date_status, confidence, score) VALUES (?, ?, ?, 'Opened a second clinic', ?, 'We opened our second clinic this month.', ?, 'verified', 80, 70)",
      [`${id}-l${i}`, id, `${tenant} clinic ${i}`, `https://news.test/${id}/${i}`, day(10)])
  await db.run("UPDATE scan_jobs SET status = 'done', finished_at = ? WHERE id = ?", [NOW, id])
  return id
}
const issue = (db: Db, runId: string, tenant = 'seller1', email = 'buyer@prospect.test', business = 'Clinic Soft') =>
  issuePreviewClaim(db, master, { runId, sellerTenantId: tenant, recipientEmail: email, business }, NOW)

bothEngines('report: issued vs claimed, ready vs held runs and why, recorded spend per run; own tenant only', async ({ db }) => {
  const a = await run(db, 'seller1', { leads: 2, spend: 0.5 })
  const b = await run(db, 'seller1', { leads: 1, spend: 0.25 })
  const empty = await run(db, 'seller1', { leads: 0, spend: 0.1 })
  const noOffer = await run(db, 'seller1', { leads: 1, seller: 'Physio software, no page cited' })
  const unpriced = await run(db, 'seller1', { leads: 1 })
  const other = await run(db, 'seller2', { leads: 3, spend: 9 })
  const ia = await issue(db, a), ib = await issue(db, b, 'seller1', 'owner@clinic2.test')
  await issue(db, other, 'seller2')
  assert.ok(ia?.status === 'issued' && ib?.status === 'issued')
  await db.run("INSERT INTO users (id, email, name, business_name, password_hash, salt, created_at, email_verified_at) VALUES ('u1', 'owner@clinic2.test', 'P', 'B', 'h', 's', ?, ?)", [NOW, NOW])
  if (ib?.status === 'issued') assert.equal((await claimPreview(db, master, ib.token, { actorId: 'u1', tenantId: 't-prospect' }, NOW)).status, 'claimed')

  const r = await proofReport(db, 'seller1', NOW)
  assert.equal(r.previews.length, 2, 'seller2\u2019s preview is not in seller1\u2019s report')
  assert.ok(r.previews.every(p => p.runId !== other))
  assert.deepEqual({ ...r.totals.conversion }, { claimed: 1, claimedWithdrawn: 0, issued: 2, rate: 0.5 })
  assert.equal(r.totals.open, 1)
  const pa = r.previews.find(p => p.runId === a)!
  assert.deepEqual([pa.state, pa.companies, pa.runSpendUsd, pa.version], ['open', 2, 0.5, PROOF_SNAPSHOT_VERSION])
  assert.deepEqual(r.previews.find(p => p.runId === b)!.claimAttempts, { claimed: 1 })
  assert.equal(r.runs.length, 5, 'every finished run of the seller is evaluated, none of seller2\u2019s')
  assert.deepEqual(r.totals.runs, { evaluated: 5, ready: 3, held: 2, holdReasons: { no_usable_results: 1, no_inferred_offer: 1 } })
  assert.equal(r.runs.find(x => x.runId === empty)!.proof, 'no_usable_results')
  assert.equal(r.runs.find(x => x.runId === noOffer)!.proof, 'no_inferred_offer')
  // spend: unrecorded is counted apart and never priced as zero; cost per shown company uses priced ready runs only
  assert.equal(r.runs.find(x => x.runId === unpriced)!.spendUsd, null)
  assert.deepEqual({ ...r.totals.spend }, { runsWithSpend: 3, runsWithoutSpend: 2, totalUsd: 0.85, perShownCompanyUsd: 0.25 })
  const json = JSON.stringify(r)
  assert.ok(!/@/.test(json), 'no recipient email (or any email) in the report')
  assert.ok(!json.includes('We opened our second clinic'), 'no snapshot content in the report')
  // the other tenant sees only its own
  const r2 = await proofReport(db, 'seller2', NOW)
  assert.deepEqual([r2.previews.length, r2.runs.length, r2.totals.spend.totalUsd], [1, 1, 9])
  // a tenant with nothing: zeros where counted, null where a ratio has no denominator
  const none = await proofReport(db, 'nobody', NOW)
  assert.deepEqual([none.totals.conversion.rate, none.totals.spend.totalUsd, none.totals.spend.perShownCompanyUsd], [null, null, null])
})

bothEngines('report: withdrawn and expired previews are named; malformed stored snapshots never throw', async ({ db }) => {
  const a = await run(db, 'seller1', { leads: 1, spend: 0.2 })
  const b = await run(db, 'seller1', { leads: 1, spend: 0.2 })
  const c = await run(db, 'seller1', { leads: 1, spend: 0.2 })
  const ia = await issue(db, a), ib = await issue(db, b), ic = await issue(db, c)
  assert.ok(ia?.status === 'issued' && ib?.status === 'issued' && ic?.status === 'issued')
  await db.run('UPDATE leads SET quarantined_at = ? WHERE scan_job_id = ?', [NOW, a])
  await db.run('UPDATE preview_claims SET expires_at = ? WHERE run_id = ?', [NOW - 1, b])
  await db.run("UPDATE preview_claims SET snapshot = 'not json' WHERE run_id = ?", [c])
  const r = await proofReport(db, 'seller1', NOW)
  const state = (run: string) => r.previews.find(p => p.runId === run)!
  assert.equal(state(a).state, 'withdrawn')
  assert.equal(state(b).state, 'expired')
  assert.deepEqual([state(c).state, state(c).companies, state(c).version], ['withdrawn', 0, 0], 'unreadable snapshot: withdrawn, never served')
  assert.deepEqual([r.totals.withdrawn, r.totals.expired, r.totals.open], [2, 1, 0])
  assert.ok(r.previews.every(p => p.serving === false), 'nothing withdrawn or expired is served')
  if (ic?.status === 'issued') assert.equal((await readPublicClaim(db, master, ic.token, NOW)).status, 'expired')
  if (ia?.status === 'issued') assert.equal((await readPublicClaim(db, master, ia.token, NOW)).status, 'expired', 'a quarantined lead withdraws the already-issued public link')
})

// Review on 7998fec9: a claim whose evidence is withdrawn afterwards stays a claim (a fact), but is reported apart from
// valid conversion, and the report, the claimed route, the public link and the counts agree on it.
bothEngines('report: a claim whose evidence is later withdrawn is claimed_withdrawn, not conversion; report, routes and counts agree', async ({ db }) => {
  const a = await run(db, 'seller1', { leads: 2, spend: 0.4 })
  const b = await run(db, 'seller1', { leads: 1, spend: 0.2 })
  const ia = await issue(db, a, 'seller1', 'owner@clinic2.test'), ib = await issue(db, b, 'seller1', 'owner@clinic2.test')
  if (ia?.status !== 'issued' || ib?.status !== 'issued') throw new Error('setup')
  await db.run("INSERT INTO users (id, email, name, business_name, password_hash, salt, created_at, email_verified_at) VALUES ('u1', 'owner@clinic2.test', 'P', 'B', 'h', 's', ?, ?)", [NOW, NOW])
  for (const t of [ia.token, ib.token]) assert.equal((await claimPreview(db, master, t, { actorId: 'u1', tenantId: 't-prospect' }, NOW)).status, 'claimed')
  let r = await proofReport(db, 'seller1', NOW)
  assert.deepEqual(r.previews.map(p => [p.state, p.serving]).sort(), [['claimed', true], ['claimed', true]])
  assert.deepEqual({ ...r.totals.conversion }, { claimed: 2, claimedWithdrawn: 0, issued: 2, rate: 1 })
  // one of run a's two leads is quarantined after the claim
  await db.run('UPDATE leads SET quarantined_at = ? WHERE id = ?', [NOW, `${a}-l1`])
  r = await proofReport(db, 'seller1', NOW)
  const pa = r.previews.find(p => p.runId === a)!, pb = r.previews.find(p => p.runId === b)!
  assert.deepEqual([pa.state, pa.serving, pb.state, pb.serving], ['claimed_withdrawn', false, 'claimed', true])
  assert.deepEqual({ ...r.totals.conversion }, { claimed: 1, claimedWithdrawn: 1, issued: 2, rate: 0.5 })
  assert.deepEqual([r.totals.claimed, r.totals.claimedWithdrawn, r.totals.open, r.totals.withdrawn, r.totals.expired], [1, 1, 0, 0, 0])
  // the private claimed route and the public link say the same thing as the report
  assert.deepEqual(await readClaimedPreview(db, 't-prospect', ia.id, NOW), { expired: true })
  assert.equal(((await readClaimedPreview(db, 't-prospect', ib.id, NOW)) as { business: string }).business, 'Clinic Soft')
  assert.equal((await readPublicClaim(db, master, ia.token, NOW)).status, 'claimed', 'a claimed link has no public content either way')
  for (const p of r.previews) {
    const page = await readClaimedPreview(db, 't-prospect', p.id, NOW)
    assert.equal(p.serving, !!page && !('expired' in page), `${p.runId}: serving matches the claimed route`)
  }
  // a claimed preview past its evidence expiry is still a claim; it serves nothing, and the route agrees
  await db.run('UPDATE preview_claims SET expires_at = ? WHERE id = ?', [NOW - 1, ib.id])
  r = await proofReport(db, 'seller1', NOW)
  const eb = r.previews.find(p => p.runId === b)!
  assert.deepEqual([eb.state, eb.serving], ['claimed', false])
  assert.deepEqual(await readClaimedPreview(db, 't-prospect', ib.id, NOW), { expired: true })
})

bothEngines('deploy: a snapshot issued before versioning still serves and reports as version 0', async ({ db }) => {
  const a = await run(db, 'seller1', { leads: 1, spend: 0.2 })
  const ia = await issue(db, a)
  if (ia?.status !== 'issued') throw new Error('setup')
  const row = await db.get<{ snapshot: string }>('SELECT snapshot FROM preview_claims WHERE id = ?', [ia.id])
  const legacy = JSON.parse(row!.snapshot) as Record<string, unknown>
  delete legacy.version
  await db.run('UPDATE preview_claims SET snapshot = ? WHERE id = ?', [JSON.stringify(legacy), ia.id])
  assert.equal((await readPublicClaim(db, master, ia.token, NOW)).status, 'ok', 'an existing live link keeps working after deploy')
  const r = await proofReport(db, 'seller1', NOW)
  assert.deepEqual([r.previews[0].state, r.previews[0].version, r.previews[0].companies], ['open', 0, 1])
  // and a re-issue of the same proof under the new builder is a new version, never the legacy row reused
  const again = await issue(db, a)
  assert.ok(again?.status === 'issued' && !again.reused && again.id !== ia.id)
})

bothEngines('report: no query it runs ever selects the recipient email', async ({ db }) => {
  const a = await run(db, 'seller1', { leads: 1, spend: 0.2 })
  assert.equal((await issue(db, a))?.status, 'issued')
  const sql: string[] = []
  const spy = new Proxy(db, { get(t, k, r) {
    const v = Reflect.get(t, k, r)
    return typeof v === 'function' && ['get', 'all', 'run'].includes(String(k)) ? (q: string, ...rest: unknown[]) => { sql.push(q); return v.call(t, q, ...rest) } : v
  } }) as Db
  const r = await proofReport(spy, 'seller1', NOW)
  assert.equal(r.previews.length, 1)
  assert.ok(sql.length >= 2, 'the spy saw the report queries')
  assert.ok(sql.every(q => !/recipient_email/i.test(q)), 'recipient_email is never selected into the report')
})

bothEngines('report: spend values that are not a recorded amount read as unrecorded, never as a number', async ({ db }) => {
  for (const spend of [null, -1]) await run(db, 'seller1', { leads: 1, spend })
  const r = await proofReport(db, 'seller1', NOW)
  assert.deepEqual(r.runs.map(x => x.spendUsd), [null, null])
  assert.deepEqual([r.totals.spend.runsWithoutSpend, r.totals.spend.totalUsd, r.totals.spend.perShownCompanyUsd], [2, null, null])
})

test('the homepage\u2019s illustrative examples can never become proof evidence', () => {
  assert.equal(EXAMPLES.real, false, 'fixture: the homepage examples are illustrations')
  let n = 0
  const leads: ProofLeadRow[] = EXAMPLES.scenarios.flatMap(s => s.leads.map(l => ({
    id: `ex${++n}`, company: l.company, signal: l.why, source_url: l.url ?? `https://${l.source}/story`, evidence_excerpt: l.quote,
    event_date: day(5), date_status: 'verified', review_reason: null, quarantined_at: null, evidence_purged_at: null, confidence: 90, score: 90,
  })))
  assert.ok(leads.length > 0)
  for (const s of EXAMPLES.scenarios) {
    const p = buildProofPreview({ run: { jobId: 'job-x', tenantId: 't1', status: 'done', finishedAt: NOW, spendUsd: null }, inferredOffer: { text: s.play, sourceUrl: `https://${s.site}/` }, leads }, NOW)
    assert.deepEqual(p, { status: 'hold', runId: 'job-x', reason: 'no_inferred_offer' }, `${s.id}: an illustrative site is never an offer source`)
  }
  const p = buildProofPreview({ run: { jobId: 'job-x', tenantId: 't1', status: 'done', finishedAt: NOW, spendUsd: null }, inferredOffer: OFFER, leads }, NOW)
  assert.deepEqual(p, { status: 'hold', runId: 'job-x', reason: 'no_usable_results' }, 'no example lead passes as evidence')
})
