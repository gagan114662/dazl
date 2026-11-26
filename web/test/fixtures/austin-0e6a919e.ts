// #1910 acceptance fixture: prod job 0e6a919ee548b26077a63e90 (testdazl681, 222420af), posted by Ziggy on
// #1910 (read-only from the prod DB). Emails were redacted there; the fixture uses .invalid addresses on the
// same domains, as Ziggy directed. Columns null on every prod row are omitted here.
import type Database from 'better-sqlite3'
import { addEnrichment } from '../../lib/connectors/store.ts'

export const AUSTIN_JOB_ID = '0e6a919ee548b26077a63e90'
export const AUSTIN_QUERY = 'Marketing agencies in Austin, TX that are hiring'
export const AUSTIN_ICP = '{"summary":"small marketing agencies","who":[],"industries":["marketing agencies"],"sizes":[],"where":["Toronto"],"signals":["hiring SDRs"],"exclude":[]}'

export interface AustinLead { id: string; company: string; company_domain: string | null; name: string; signal: string; source_url: string; event_date: string | null; date_status: string; review_reason: string; evidence_excerpt: string }
export const AUSTIN_LEADS: AustinLead[] = [
  { id: '77acfb07ac2d1233377b0760', company: 'Resplendent Agency', company_domain: 'resplendent.agency', name: 'Ali Slutsky', signal: 'Hiring a Social Media Intern to join its PR team in Austin, Texas', source_url: 'https://resplendent.agency/were-hiring-social-media-intern-fall/', event_date: '2026-09-17', date_status: 'unverified', review_reason: 'source_review_required', evidence_excerpt: 'Resplendent Agency is hiring a Social Media Intern to join our PR team in Austin, Texas.' },
  { id: '2d3d97cedf8132e904586724', company: 'Zilker Media', company_domain: 'zilkermedia.com', name: 'Paige Velasquez Budde', signal: 'Hiring an Account Manager/Brand Strategist in Austin, TX', source_url: 'https://www.indeed.com/viewjob?jk=12206660f9bfcd0c', event_date: null, date_status: 'undated', review_reason: 'source_review_required', evidence_excerpt: 'Account Manager/Brand Strategist' },
  { id: 'f7c6aae70785a779bc265621', company: 'DIGI Search', company_domain: null, name: '', signal: 'Hiring a Strategic Account Manager for its Austin, TX office (hybrid)', source_url: 'https://www.ziprecruiter.com/c/DIGI-Search/Job/Strategic-Account-Manager/-in-Austin,TX?jid=da11bacde56042d4', event_date: null, date_status: 'undated', review_reason: 'source_review_required', evidence_excerpt: 'Strategic Account Manager – Digital Marketing (Austin, TX – Hybrid)' },
]

export const AUSTIN_ENRICHMENTS = [
  { lead_id: '77acfb07ac2d1233377b0760', kind: 'person', value: 'Ali Slutsky, CEO', label: 'named on a public page', source_url: 'https://resplendent.agency/about/' },
  { lead_id: '77acfb07ac2d1233377b0760', kind: 'email', value: 'ali@resplendent.agency.invalid', label: 'published on a public page', source_url: 'https://whatnow.com/wp-content/uploads/2024/11/WhatNowMedia-PartnerGuide_April_2025.pdf' },
  { lead_id: '77acfb07ac2d1233377b0760', kind: 'linkedin', value: 'https://www.linkedin.com/in/ali-slutsky/', label: 'linked from a public page', source_url: 'https://resplendent.agency/about/' },
  { lead_id: '2d3d97cedf8132e904586724', kind: 'person', value: 'Paige Velasquez Budde, Co-Founder & CEO', label: 'named on a public page', source_url: 'https://zilkermedia.com/team/paige-velasquez-budde/' },
  { lead_id: '2d3d97cedf8132e904586724', kind: 'email', value: 'paige@zilkermedia.com.invalid', label: 'published on a public page', source_url: 'https://zilkermedia.com/team/paige-velasquez-budde/' },
  { lead_id: '2d3d97cedf8132e904586724', kind: 'linkedin', value: 'https://www.linkedin.com/in/paigevelasquez/', label: 'linked from a public page', source_url: 'https://zilkermedia.com/team/paige-velasquez-budde/' },
]

export function seedAustinJob(db: Database.Database, tenant: string, now: number): void {
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, icp, status, candidates, verified, needs_review, created_at, finished_at) VALUES (?, ?, 'a B2B sales-automation SaaS', '(from request)', '-', ?, ?, 'running', 4, 0, 3, ?, ?)")
    .run(AUSTIN_JOB_ID, tenant, AUSTIN_QUERY, AUSTIN_ICP, now - 3600, now - 3500)
  db.prepare("UPDATE scan_jobs SET funded_by = 'trial', spend_reserved_usd = 0.2813, icp_inferred = 3 WHERE id = ?").run(AUSTIN_JOB_ID)
  const ins = db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, contact, signal, source_url, evidence_excerpt, event_date, date_status, retrieved_at, dedup_key, review_reason, source_kind, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'discover', ?)")
  for (const l of AUSTIN_LEADS) ins.run(l.id, AUSTIN_JOB_ID, l.name, l.company, l.company_domain, l.signal, l.source_url, l.evidence_excerpt, l.event_date, l.date_status, now - 3500, `dedup-${l.id}`, l.review_reason, now - 3500)
  for (const e of AUSTIN_ENRICHMENTS) addEnrichment(db, tenant, e.lead_id, { connector: 'discover', kind: e.kind, value: e.value, label: e.label, confidence: null, source_url: e.source_url, source_date: '2026-11-26', retrieved_at: now - 3500 })
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(AUSTIN_JOB_ID) // leads can only be added to a running job; prod's job is done
}
