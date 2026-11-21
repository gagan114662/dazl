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

test('company-first: a lead the gate shows is counted, a held one is held by checks, and no read means held, never review', async () => {
  const db = new Database(':memory:')
  try {
    migrateAllSqlite(db)
    migrateCompanyFirstPublishedDisplay(db)
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
    db.prepare("UPDATE scan_jobs SET status='done' WHERE id=?").run(enriching)
    const e = (await listCampaignsNow(db, tenant, 10, now)).find(c => c.id === enriching)!
    assert.deepEqual([e.next.label, e.qualification.needsReview], ['Search still running', 0], 'done, enrichment still running')
  } finally { db.close() }
})
