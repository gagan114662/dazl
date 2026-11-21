// Shared fixture (#1062): the verified display-only shape of test/company-first-display-view.test.ts - a company-first scan whose final checks
// show one lead (River Ledger, display proof) and hold another (Other Co) - left 'running' for the caller to finish. Real store writes only.
import type Database from 'better-sqlite3'
import { sqliteDb } from '../../lib/db/client.ts'
import { addEnrichment } from '../../lib/connectors/store.ts'
import { markCompanyFirstBudget } from '../../lib/company-first/product-discovery.ts'
import { COMPANY_FIRST_ROLE_LABEL, recordCompanyFirstPublishedDisplay } from '../../lib/people/company-first-published-display.ts'
import { recordActionability } from '../../lib/scan/actionable.ts'
import { recordNeedEvidence } from '../../lib/scan/need-evidence.ts'
import { recordTimingProof } from '../../lib/scan/timing-proof.ts'

// The verified display-only shape of company-first-display-view.test.ts (one lead the gate shows once the scan is done and enriched), plus one
// held lead, on a company-first scan left 'running'.
export async function seed(db: Database.Database) {
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