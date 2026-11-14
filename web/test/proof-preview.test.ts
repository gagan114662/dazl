import test from 'node:test'
import assert from 'node:assert/strict'
import { buildProofPreview, loadProofInput, PROOF_MAX_COMPANIES, type ProofInput, type ProofLeadRow } from '../lib/scan/proof-preview.ts'
import { bothEngines } from './helpers/engines.ts'

// Synthetic run: no real run ids, companies or people.
const NOW = Date.UTC(2026, 9, 30)
const day = (n: number) => new Date(NOW - n * 86400_000).toISOString().slice(0, 10)
const OFFER = { text: 'Appointment reminders for physiotherapy clinics', sourceUrl: 'https://prospect-clinicsoft.test/about' }
let n = 0
const lead = (over: Partial<ProofLeadRow> = {}): ProofLeadRow => ({
  id: `l${++n}`, company: `Company ${n}`, signal: 'Opened a second clinic', source_url: `https://news.test/a${n}`,
  evidence_excerpt: 'We opened our second clinic this month.', event_date: day(10), date_status: 'unverified', event_date_proof: 'page_bound', review_reason: null,
  quarantined_at: null, evidence_purged_at: null, confidence: 80, score: 70, ...over,
})
const input = (leads: ProofLeadRow[], over: Partial<ProofInput> = {}): ProofInput => ({
  run: { jobId: 'job-synthetic-1', tenantId: 't1', status: 'done', finishedAt: NOW, spendUsd: 0.42 }, inferredOffer: OFFER, leads, ...over,
})

test('ready: only this run\'s gated leads, each with an https source, offer marked as inferred, spend recorded', () => {
  const p = buildProofPreview(input([lead({ company: 'Northside Physio', score: 90 }), lead({ company: 'Lakeview Rehab' })]), NOW)
  assert.equal(p.status, 'ready')
  if (p.status !== 'ready') return
  assert.deepEqual(p.companies.map(c => c.company), ['Northside Physio', 'Lakeview Rehab'])
  assert.ok(p.companies.every(c => c.sourceUrl.startsWith('https://')))
  assert.deepEqual(p.offer, { inferred: true, ...OFFER })
  assert.equal(p.spendUsd, 0.42)
  assert.equal(p.runId, 'job-synthetic-1')
  assert.match(p.disclaimer, /not guaranteed/)
  assert.equal(p.expiresAt, Date.parse(day(10)) + 90 * 86400_000)
})

test('gates: review, quarantine, purge, unverified/old/future dates, http, illustrations and missing quotes never appear', () => {
  const bad = [
    lead({ review_reason: 'quote_unconfirmed' }), lead({ quarantined_at: NOW }), lead({ evidence_purged_at: NOW }), lead({ confidence: null }),
    lead({ event_date_proof: null }), lead({ event_date_proof: 'verified' as never }), lead({ date_status: 'verified', event_date_proof: null }), lead({ gate_held: 1 }), lead({ date_status: 'undated', event_date: null, event_date_proof: null }), lead({ event_date: day(120) }), lead({ event_date: day(-3) }),
    lead({ source_url: 'http://news.test/plain' }), lead({ source_url: 'https://uktechnews.example/x' }), lead({ evidence_excerpt: null }), lead({ company: '' }),
  ]
  assert.deepEqual(buildProofPreview(input(bad), NOW), { status: 'hold', runId: 'job-synthetic-1', reason: 'no_usable_results' })
  const p = buildProofPreview(input([...bad, lead({ company: 'Kept Co' })]), NOW)
  assert.equal(p.status === 'ready' && p.companies.map(c => c.company).join(), 'Kept Co')
})

test('privacy: emails and phone numbers are removed from previews; no contact field exists', () => {
  const p = buildProofPreview(input([lead({ signal: 'Hiring, email jane.doe@clinic.test', evidence_excerpt: 'Call us on +1 (416) 555-0199 to book.' })]), NOW)
  assert.equal(p.status, 'ready')
  const s = JSON.stringify(p)
  assert.doesNotMatch(s, /jane\.doe|555-0199/)
  assert.match(s, /\[removed\]/)
  assert.ok(p.status === 'ready' && !('contact' in p.companies[0]))
})

test('bounded and deduped by company', () => {
  const many = Array.from({ length: 12 }, (_, i) => lead({ company: i < 2 ? 'Same Co' : `Co ${i}`, score: 100 - i }))
  const p = buildProofPreview(input(many), NOW)
  assert.equal(p.status === 'ready' && p.companies.length, PROOF_MAX_COMPANIES)
  assert.equal(p.status === 'ready' && p.companies.filter(c => c.company === 'Same Co').length, 1)
})

test('holds: unfinished run, no inferred offer, an illustration as the offer source, or zero results never build a message', () => {
  assert.equal((buildProofPreview(input([lead()], { run: { ...input([]).run, status: 'running' } }), NOW) as { reason: string }).reason, 'run_not_finished')
  assert.equal((buildProofPreview(input([lead()], { inferredOffer: null }), NOW) as { reason: string }).reason, 'no_inferred_offer')
  assert.equal((buildProofPreview(input([lead()], { inferredOffer: { text: 'x', sourceUrl: 'https://ledgerline.example' } }), NOW) as { reason: string }).reason, 'no_inferred_offer')
  assert.equal((buildProofPreview(input([]), NOW) as { reason: string }).reason, 'no_usable_results')
})

bothEngines('loadProofInput: reads only the owning tenant\'s run and its own leads', async ({ db }) => {
  for (const [id, user] of [['job-a', 't1'], ['job-b', 't2']]) {
    await db.run("INSERT INTO scan_jobs (id, user_id, status, business_name, industry, location) VALUES (?, ?, 'pending', 'Synthetic', 'software', 'Toronto')", [id, user])
    await db.run("UPDATE scan_jobs SET status = 'running' WHERE id = ?", [id])
    await db.run("INSERT INTO leads (id, scan_job_id, company, signal, source_url, evidence_excerpt, event_date, date_status, event_date_proof, confidence, score) VALUES (?, ?, ?, 'Opened a clinic', 'https://news.test/x', 'We opened.', ?, 'unverified', 'page_bound', 80, 70)", [`${id}-l`, id, `${user} company`, day(5)])
    await db.run("UPDATE scan_jobs SET status = 'done', finished_at = ? WHERE id = ?", [Math.floor(NOW / 1000), id])
  }
  const extra = { inferredOffer: OFFER, spendUsd: null }
  assert.equal(await loadProofInput(db, 't1', 'job-b', extra), null)
  const mine = await loadProofInput(db, 't1', 'job-a', extra)
  assert.deepEqual(mine?.leads.map(l => l.company), ['t1 company'])
  const p = buildProofPreview(mine!, NOW)
  assert.equal(p.status === 'ready' && p.companies[0].company, 't1 company')
})

test('HOLD: every emitted field obeys the privacy contract, URLs included; impossible calendar dates are rejected', () => {
  const p = buildProofPreview(input([
    lead({ id: 'a', company: 'Acme (owner@acme.test)', score: 99 }),
    lead({ id: 'b', company: 'Beta Co', source_url: 'https://forum.test/t/2?contact=sales%40beta.test', score: 98 }),
    lead({ id: 'c', company: 'Gamma Co', source_url: 'https://forum.test/t/3?call=%2B1%20415%20555%200100', score: 97 }),
    lead({ id: 'd', company: 'Delta Co', source_url: 'https://forum.test/t/4#reach-me-at-delta@mail.test', score: 96 }),
    lead({ id: 'e', company: 'owner@epsilon.test', score: 95 }),
    lead({ id: 'f', company: 'Zeta Co', source_url: 'https://forum.test/t/1234567890123', score: 94 }),
  ]), NOW)
  assert.equal(p.status, 'ready')
  if (p.status !== 'ready') return
  assert.deepEqual(p.companies.map(c => c.company), ['Acme', 'Zeta Co'], 'contact text scrubbed from company; contact-bearing URLs and contact-only companies dropped; page-id digits kept')
  const text = JSON.stringify(p)
  for (const leak of ['@', '555', '%40', '%2B1']) assert.ok(!text.includes(leak), leak)
  // the offer's source URL too: a contact detail in it holds the preview instead of being shown
  for (const sourceUrl of ['https://seller.test/about?email=me%40seller.test', 'https://seller.test/about?tel=+1-415-555-0100', 'https://seller.test/about#me@seller.test'])
    assert.deepEqual(buildProofPreview(input([lead()], { inferredOffer: { text: 'Scheduling software for clinics', sourceUrl } }), NOW), { status: 'hold', runId: 'job-synthetic-1', reason: 'no_inferred_offer' }, sourceUrl)
  // impossible or loosely formatted dates are never normalised into proof
  for (const event_date of ['2026-09-31', '2026-02-30', '2026-13-01', '2026-9-1', `${day(10)}T00:00:00Z`, 'October 20, 2026'])
    assert.equal(buildProofPreview(input([lead({ event_date })]), NOW).status, 'hold', event_date)
})

// #1176 (council review): the preview applies the holds Home applies to a lead with a proven day: the REQUIRED check's own verdict
// (requiredGateHeldForJob: a failed marker, and the default-deny when the request needs the sales-hiring proof and no pass was recorded), the
// run's own recency window, and a hold no confirmation lifts. The timing proof (domain + named person + published route) is NOT required:
// a preview carries no person and no contact by contract, so that proof can never exist for it.
bothEngines('#1176 loadProofInput: a lead with a proven day is held out of the preview by a failed or missing required check, the run\'s own window and an uncheckable cause', async ({ db }) => {
  const SALES = 'B2B software companies hiring account executives'
  const job = async (id: string, query: string, icp: string | null) => {
    await db.run("INSERT INTO scan_jobs (id, user_id, status, business_name, industry, location, query, icp) VALUES (?, 't1', 'pending', 'Synthetic', 'software', 'Toronto', ?, ?)", [id, query, icp])
    await db.run("UPDATE scan_jobs SET status = 'running' WHERE id = ?", [id])
  }
  const add = async (jobId: string, id: string, o: { date?: string; from?: string | null } = {}) => {
    await db.run("INSERT INTO leads (id, scan_job_id, company, signal, source_url, evidence_excerpt, event_date, date_status, event_date_proof, confidence, score, human_confirmed_from) VALUES (?, ?, ?, 'Opened a clinic', 'https://news.test/x', 'We opened.', ?, 'unverified', 'page_bound', 80, 70, ?)", [id, jobId, `Co ${id}`, o.date ?? new Date().toISOString().slice(0, 10), o.from ?? null])
  }
  const mark = (leadId: string, kind: string, value: string) => db.run("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, source_url, source_date, retrieved_at) VALUES (?, ?, 't1', 'scan:gate', ?, ?, 'https://invalid.example/', '2026-11-13', 1)", [`m-${leadId}-${value}`, leadId, kind, value])
  const done = async (id: string) => db.run("UPDATE scan_jobs SET status = 'done', finished_at = ? WHERE id = ?", [Math.floor(Date.now() / 1000), id])
  const extra = { inferredOffer: OFFER, spendUsd: null }
  const companies = async (id: string) => { const p = buildProofPreview((await loadProofInput(db, 't1', id, extra))!); return p.status === 'ready' ? p.companies.map(c => c.company).sort() : [`hold:${p.reason}`] }

  // a sales-hiring request: only the lead with a recorded PASS is shown; a failed marker and no record at all are held
  await job('j-sales', SALES, null)
  await add('j-sales', 'pass'); await mark('pass', 'gate_passed', 'requested_role_v1'); await mark('pass', 'gate_passed', 'sales_hiring')
  await add('j-sales', 'norecord')
  await add('j-sales', 'failed'); await mark('failed', 'gate_failed', 'sales_hiring_check_failed')
  await done('j-sales')
  assert.deepEqual(await companies('j-sales'), ['Co pass'])
  // an ordinary request has no sales-hiring gate: a lead with no marker is shown, a failed marker still holds it
  await job('j-plain', 'dental practices opening a new location', null)
  await add('j-plain', 'plain'); await add('j-plain', 'plainfailed'); await mark('plainfailed', 'gate_failed', 'sales_hiring_check_failed')
  await done('j-plain')
  assert.deepEqual(await companies('j-plain'), ['Co plain'])
  // the run's own recency window (7 days): a proven day 10 days old is outside it, however recent the preview's own 90 days are
  await job('j-window', 'dental practices opening a new location in the last 7 days', JSON.stringify({ summary: 's', who: [], industries: [], sizes: [], where: [], signals: [], exclude: [], window_days: 7 }))
  await add('j-window', 'old', { date: new Date(Date.now() - 10 * 86400_000).toISOString().slice(0, 10) }); await add('j-window', 'fresh', { date: new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 10) })
  await done('j-window')
  assert.deepEqual(await companies('j-window'), ['Co fresh'])
  // a lead the user confirmed out of someone else's customer / another place / a closed opening stays out
  await job('j-unc', 'dental practices opening a new location', null)
  await add('j-unc', 'fine'); await add('j-unc', 'customer', { from: 'counterparty_signal' }); await add('j-unc', 'closed', { from: 'job_closed' })
  await done('j-unc')
  assert.deepEqual(await companies('j-unc'), ['Co fine'])
})
