// #1062 positive control: the Campaigns list and the Leads page's Past scans count a company-first scan through the same gate as /api/leads
// and the run page (companyFirstResults().visibleIds). A lead that gate shows is still counted (not hidden as held); a lead it holds is held by
// checks, never "needs your review". And without that read, a company-first scan's leads are held (fail closed), never reviewable.
// Fixture: the verified display-only shape of company-first-display-view.test.ts, plus one held lead in the same scan.
import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { sqliteDb } from '../lib/db/client.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { addEnrichment } from '../lib/connectors/store.ts'
import { markCompanyFirstBudget } from '../lib/company-first/product-discovery.ts'
import { COMPANY_FIRST_ROLE_LABEL, migrateCompanyFirstPublishedDisplay, recordCompanyFirstPublishedDisplay } from '../lib/people/company-first-published-display.ts'
import { recordActionability } from '../lib/scan/actionable.ts'
import { recordNeedEvidence } from '../lib/scan/need-evidence.ts'
import { recordTimingProof } from '../lib/scan/timing-proof.ts'
import { companyFirstResults } from '../lib/scan/company-first-results.ts'
import { historyCampaigns, listCampaigns, listCampaignsNow } from '../lib/outreach/campaigns.ts'
import { beginEnrichment } from '../lib/scan/enrichment.ts'

// The verified display-only shape of company-first-display-view.test.ts (one lead the gate shows once the scan is done and enriched), plus one
// held lead, on a company-first scan left 'running'.
async function seed(db: Database.Database) {
  const tenant = 'display-test-owner', id = '1'.repeat(24), lead = '2'.repeat(24), heldLead = '3'.repeat(24)
  const now = new Date(), at = Math.floor(now.getTime() / 1000)
  const day = new Date(now.getTime() - 3 * 86_400_000).toISOString().slice(0, 10)
  const host = 'riverledger.co.uk', query = 'Companies hiring sales reps', icp = JSON.stringify({ who: ['Owner'], where: ['London, England, United Kingdom'], window_days: 20 })
  const team = `https://${host}/team`, signalPage = `https://${host}/vacancy`, role = 'Ada Lane, Owner'
  db.prepare("INSERT INTO users (id,email,business_name,password_hash,salt) VALUES (?, 'owner@example.test','Seller','salted','salt')").run(tenant)
  db.prepare("INSERT INTO scan_jobs (id,user_id,business_name,industry,location,status,attempts,query,icp,run_budget) VALUES (?,?,'Seller','-','-','running',1,?,?,?)").run(id, tenant, query, icp, markCompanyFirstBudget(null))
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, confidence, fit, score, signal, signal_kind, source_url, evidence_excerpt, event_date, event_date_proof, company_domain) VALUES (?,?,'','River Ledger',80,5,75,'Open sales representative vacancy','hiring',?,?,?,'page_bound',?)")
    .run(lead, id, signalPage, `River Ledger posted a sales representative vacancy on ${day}.`, day, host)
  // held: a reviewable reason and an in-window date, but nothing the final checks accept
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, score, signal, signal_kind, source_url, event_date, review_reason) VALUES (?,?,'','Other Co',60,'Open sales vacancy','hiring','https://other.example/jobs',?,'quote_unconfirmed')").run(heldLead, id, day)
  const add = (connector: string, kind: string, value: string, label: string | null, url: string) => addEnrichment(db, tenant, lead, { connector, kind, value, label, confidence: null, source_url: url, source_date: day, retrieved_at: at })
  add('sitecrawl', 'domain', `${host}|evidence_own_domain`, 'domain-basis-v1:evidence_own_domain', signalPage)
  add('sitecrawl', 'person', role, COMPANY_FIRST_ROLE_LABEL + 'Owner', team)
  add('scan:gate', 'gate_passed', 'requested_role_v1', 'role verified', signalPage)
  add('scan:gate', 'gate_passed', 'sales_hiring', 'role verified', signalPage)
  await recordCompanyFirstPublishedDisplay(sqliteDb(db), tenant, lead, id, 1, { domain: host, person: role, address: `ada.lane@${host}`, source_url: team, role_quote: 'Owner', observed_at: at })
  const job = { id, user_id: tenant, query, icp }
  await recordNeedEvidence(sqliteDb(db), tenant, id, { asOf: now, windowDays: 20 })
  recordActionability(db, job)
  recordTimingProof(db, job, now)
  return { tenant, id, lead, heldLead, now, at, day, query, icp }
}

test('company-first: a lead the gate shows is counted, a held one is held by checks, and no read means held, never review', async () => {
  const db = new Database(':memory:')
  try {
    migrateAllSqlite(db)
    migrateCompanyFirstPublishedDisplay(db)
    const { tenant, id, lead, now, at, day, query, icp } = await seed(db)
    db.prepare("UPDATE scan_jobs SET status='done',candidates=2,dropped=0,enrich_finished_at=? WHERE id=? AND user_id=?").run(at, id, tenant)
    const result = await companyFirstResults(sqliteDb(db), tenant, id, now)
    assert.deepEqual([...(result?.visibleIds ?? [])], [lead], 'the gate shows the verified lead only')

    const listed = (await listCampaignsNow(db, tenant, 10, now)).find(c => c.id === id)!
    const history = (await historyCampaigns(db, sqliteDb(db), tenant, [id], now)).find(c => c.id === id)!
    for (const [name, c] of [['list', listed], ['history', history]] as const) {
      assert.equal(c.qualification.sourceChecked, 1, `${name}: the lead the gate shows is still counted, not hidden`)
      assert.equal(c.qualification.heldByChecks, 1, `${name}: the held one is held by checks`)
      assert.equal(c.qualification.needsReview, 0, `${name}: and never needs review`)
      assert.equal(c.qualification.research, 1, `${name}: counted once, as research`)
    }
    // No gate read passed (the sync reader on its own): fail closed - every lead held, none reviewable or passed.
    const closed = listCampaigns(db, tenant, 10).find(c => c.id === id)!
    assert.deepEqual([closed.qualification.heldByChecks, closed.qualification.needsReview, closed.qualification.sourceChecked + closed.qualification.confirmedByYou], [2, 0, 0])
    assert.doesNotMatch(closed.next.label, /review/i)

    // A failed company-first scan keeps nextAction's own "Search failed" step, even with no recorded outcome to replace it (sonnet, round 3);
    // only a done scan whose enrichment is still running reads "Search still running".
    const failed = '4'.repeat(24)
    db.prepare("INSERT INTO scan_jobs (id,user_id,business_name,industry,location,status,attempts,query,icp,run_budget) VALUES (?,?,'Seller','-','-','running',1,?,?,?)").run(failed, tenant, query, icp, markCompanyFirstBudget(null))
    db.prepare("INSERT INTO leads (id, scan_job_id, name, company, score, signal, source_url, event_date, review_reason) VALUES (?,?,'','Failed Co',60,'Open sales vacancy','https://failed.example/jobs',?,'quote_unconfirmed')").run('5'.repeat(24), failed, day)
    db.prepare("UPDATE scan_jobs SET status='failed', error='provider error' WHERE id=?").run(failed)
    const f1 = (await listCampaignsNow(db, tenant, 10, now)).find(c => c.id === failed)!
    const f2 = (await historyCampaigns(db, sqliteDb(db), tenant, [failed], now)).find(c => c.id === failed)!
    for (const c of [f1, f2]) assert.deepEqual([c.next.label, c.qualification.needsReview], ['Search failed. Open it to see why', 0])
    const enriching = '6'.repeat(24)
    db.prepare("INSERT INTO scan_jobs (id,user_id,business_name,industry,location,status,attempts,query,icp,run_budget) VALUES (?,?,'Seller','-','-','running',1,?,?,?)").run(enriching, tenant, query, icp, markCompanyFirstBudget(null))
    db.prepare("INSERT INTO leads (id, scan_job_id, name, company, score, signal, source_url, event_date, review_reason) VALUES (?,?,'','Pending Co',60,'Open sales vacancy','https://pending.example/jobs',?,'quote_unconfirmed')").run('7'.repeat(24), enriching, day)
    db.prepare("UPDATE scan_jobs SET status='done', enrich_started_at=? WHERE id=?").run(at - 60, enriching)
    const e = (await listCampaignsNow(db, tenant, 10, now)).find(c => c.id === enriching)!
    assert.deepEqual([e.next.label, e.qualification.needsReview], ['Search still running', 0], 'done, enrichment still running')
    // Interrupted (no end mark 11 minutes after it started: lib/scan/enrichment.ts ENRICH_STALE_S): never "still running" forever (Qodo), never reviewable.
    db.prepare('UPDATE scan_jobs SET enrich_started_at=? WHERE id=?').run(at - 11 * 60, enriching)
    const i1 = (await listCampaignsNow(db, tenant, 10, now)).find(c => c.id === enriching)!
    const i2 = (await historyCampaigns(db, sqliteDb(db), tenant, [enriching], now)).find(c => c.id === enriching)!
    for (const c of [i1, i2]) assert.deepEqual([c.next.label, c.qualification.needsReview], ['Final checks did not finish, so no lead can be shown. Run the search again', 0])
  } finally { db.close() }
})

// Qodo on #1466 ("New scans can show false held counts"): the Campaigns list must read each scan once and judge it from that one read. Forced
// interleaving, no mock: right after the list's own scan_jobs read, the scan finishes (done, enrichment finished). The card must be one
// consistent snapshot - still running, or done with its visible lead counted - never done with that lead counted as held by checks.
test('company-first: a scan that finishes while the Campaigns list is being read is never shown done with its visible lead held', async () => {
  let armed = false, id = '', at = 0
  const db: Database.Database = new Database(':memory:', { verbose: (sql: unknown) => {
    if (armed && /^SELECT id, query, status, error, created_at, candidates, run_budget/.test(String(sql))) {
      armed = false
      queueMicrotask(() => db.prepare("UPDATE scan_jobs SET status='done',candidates=2,dropped=0,enrich_started_at=?,enrich_finished_at=? WHERE id=?").run(at - 30, at, id))
    }
  } })
  try {
    migrateAllSqlite(db)
    migrateCompanyFirstPublishedDisplay(db)
    const seeded = await seed(db)
    id = seeded.id; at = seeded.at
    const now = seeded.now
    armed = true
    const c = (await listCampaignsNow(db, 'display-test-owner', 10, now)).find(x => x.id === id)!
    assert.equal(armed, false, 'the interleaving happened')
    assert.equal((db.prepare('SELECT status FROM scan_jobs WHERE id = ?').get(id) as { status: string }).status, 'done', 'the scan finished mid-read')
    if (c.status === 'running') assert.deepEqual([c.next.label, c.qualification.needsReview], ['Search still running', 0], 'snapshot: still running')
    else assert.deepEqual([c.status, c.qualification.sourceChecked, c.qualification.heldByChecks, c.qualification.needsReview], ['done', 1, 1, 0], 'snapshot: done, the visible lead counted')
    // and once it is read again, the finished scan shows its visible lead
    const after = (await listCampaignsNow(db, 'display-test-owner', 10, now)).find(x => x.id === id)!
    assert.deepEqual([after.status, after.qualification.sourceChecked, after.qualification.heldByChecks, after.qualification.needsReview], ['done', 1, 1, 0])
  } finally { db.close() }
})

// The same race the other way (Qodo on #1466, "Enriching leads can briefly appear held", in the Campaigns readers): the list reads a finished
// scan, then a new enrichment attempt starts before its visibility is read. That visibility read is not this scan's final result: the card
// says the search is still running, and never counts its leads as held by checks. Forced with the real beginEnrichment, no mock.
test('company-first: an enrichment attempt that starts while the Campaigns list is read never turns its leads into held-by-checks', async () => {
  let armed = false, id = ''
  const db: Database.Database = new Database(':memory:', { verbose: (sql: unknown) => {
    if (armed && /^SELECT id, query, status, error, created_at, candidates, run_budget/.test(String(sql))) {
      armed = false
      queueMicrotask(() => beginEnrichment(db, id, 1))
    }
  } })
  try {
    migrateAllSqlite(db)
    migrateCompanyFirstPublishedDisplay(db)
    const seeded = await seed(db)
    id = seeded.id
    db.prepare("UPDATE scan_jobs SET status='done',candidates=2,dropped=0,enrich_started_at=?,enrich_finished_at=? WHERE id=?").run(seeded.at - 30, seeded.at, id)
    armed = true
    const c = (await listCampaignsNow(db, 'display-test-owner', 10, seeded.now)).find(x => x.id === id)!
    assert.equal(armed, false, 'the interleaving happened')
    assert.equal((db.prepare('SELECT enrich_finished_at FROM scan_jobs WHERE id = ?').get(id) as { enrich_finished_at: number | null }).enrich_finished_at, null, 'a new attempt started')
    assert.deepEqual([c.next.label, c.qualification.heldByChecks, c.qualification.needsReview], ['Search still running', 2, 0], 'still checking: held (fail closed), but never "held by checks" as a verdict')
  } finally { db.close() }
})
