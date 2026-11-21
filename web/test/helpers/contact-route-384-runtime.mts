// #384 route seam (11-06 audit finding): GET /api/leads (real handler, stubbed session, no network) serves a lead whose own
// contact equals an address the site crawl recorded on a page. The card's provenance line (leadCardSummary -> contactRoute) must
// name the page the crawl recorded, with that crawl's own read time, as createDraft's addressCitationUrl already does: equality
// with lead.contact does not prove the cited news page printed it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { addEnrichment } from '../../lib/connectors/store.ts'
import { contextLabel } from '../../lib/outreach/contact-context.ts'
import { addressCitationUrl } from '../../lib/outreach/published-email.ts'
import { leadCardSummary } from '../../lib/scan/lead-card.ts'
import type { CardLead } from '../../lib/scan/opportunity.ts'
import { GET as leadsGET } from '../../app/api/leads/route.ts'

globalThis.fetch = (async () => { throw new Error('Unexpected network call') }) as typeof fetch

const job = 'c'.repeat(24)
// The audit's exact shape: lead.contact hello@company.example, lead.source_url https://news.example/story; the SAME address stored
// by sitecrawl from https://company.example/contact, retrieved_at 1609459200 (1 Jan 2021).
const OLD_READ = 1609459200
// The newest sitecrawl email row on prod at the 11-12 live check was read 2026-10-24 (retrieved_at 1792800513).
const PROD_READ = 1792800513

async function servedLeads(): Promise<CardLead[]> {
  const res = await leadsGET(new NextRequest(`http://test/api/leads?job_id=${job}`))
  assert.equal(res.status, 200)
  return (await res.json() as { leads: CardLead[] }).leads
}

test('#384 GET /api/leads: a direct contact the crawl also recorded keeps the crawl page and its age on the card', async () => {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  setScanDb(db); setUser({ id: 'A', business_name: 'Acme' })
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, status, candidates, created_at) VALUES (?, 'A', 'x', '(from request)', '-', 'Dental clinics that opened a new office', 'running', 3, 1000)").run(job)
  const add = (id: string, company: string, contact: string) => db.prepare("INSERT INTO leads (id, scan_job_id, company, signal, source_url, confidence, evidence_excerpt, fit, contact) VALUES (?, ?, ?, 'opened a new office', 'https://news.example/story', 80, ?, 4, ?)")
    .run(id, job, company, `${company} opened a new office.`, contact)
  const crawl = (lead: string, site: string, email: string, token: string, at: number) => {
    addEnrichment(db, 'A', lead, { connector: 'sitecrawl', kind: 'domain', value: `${site}|${token}`, label: `domain-basis-v1:${token}`, confidence: null, source_url: `https://${site}/`, source_date: '2026-10-24', retrieved_at: at })
    addEnrichment(db, 'A', lead, { connector: 'sitecrawl', kind: 'email', value: email, label: contextLabel({ excerpt: `Contact us: ${email}`, source_url: `https://${site}/contact` }), confidence: null, source_url: `https://${site}/contact`, source_date: '2026-10-24', retrieved_at: at })
  }
  // Weak website evidence (name_probe), old read: the audit case.
  add('weak', 'Company Dental', 'hello@company.example'); crawl('weak', 'company.example', 'hello@company.example', 'name_probe', OLD_READ)
  // Strong website evidence (the cited page is on the domain), the prod read time.
  add('strong', 'Strong Dental', 'hello@strongdental.example'); crawl('strong', 'strongdental.example', 'hello@strongdental.example', 'evidence_own_domain', PROD_READ)
  // Control: the direct address has no matching crawl record (the crawl recorded a different address).
  add('control', 'Control Dental', 'dana@news.example'); crawl('control', 'controldental.example', 'hello@controldental.example', 'evidence_own_domain', PROD_READ)

  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(job)
  const leads = await servedLeads()
  const card = (id: string) => { const l = leads.find(x => x.id === id); assert.ok(l, id); return { lead: l, route: leadCardSummary(l).route! } }

  const weak = card('weak')
  assert.equal(weak.route.provenance.url, 'https://company.example/contact', 'the page the crawl recorded, not the cited news story')
  assert.equal(weak.route.provenance.url, addressCitationUrl(weak.lead), 'the card and the draft cite the same page')
  assert.equal(weak.route.provenance.state, 'unconfirmed_site', 'the weak (name-guessed) website stays visible')
  assert.equal(weak.route.provenance.lastReadAt, OLD_READ, 'the crawl age is kept')
  assert.equal(weak.route.provenance.stale, true)
  assert.match(weak.route.provenance.text, /printed on a page at company\.example, a website not confirmed as the company's own, last read 1 Jan 2021 \(\d+ days ago, may be out of date\)/)
  assert.doesNotMatch(weak.route.provenance.text, /cited page|read when the scan ran/)

  // The status line agrees with the provenance line: the cited page is not called the place the address was printed.
  const weakStatus = leadCardSummary(weak.lead).contactStatus!
  assert.equal(weakStatus.confirmed, false)
  assert.doesNotMatch(weakStatus.text, /cited page/)
  assert.match(weakStatus.text, /^Unconfirmed - name match only: company\.example/)

  const strong = card('strong')
  assert.match(leadCardSummary(strong.lead).contactStatus!.text, /^Confirmed: strongdental\.example: /)
  assert.equal(strong.route.provenance.state, 'company_site')
  assert.equal(strong.route.provenance.url, 'https://strongdental.example/contact')
  assert.equal(strong.route.provenance.lastReadAt, PROD_READ)
  assert.match(strong.route.provenance.text, /printed on the company website \(strongdental\.example\), last read 24 Oct 2026/)

  const control = card('control')
  assert.match(leadCardSummary(control.lead).contactStatus!.text, /^Confirmed: address printed on the cited page\./)
  assert.equal(control.route.email, 'dana@news.example')
  assert.equal(control.route.provenance.state, 'cited_page')
  assert.equal(control.route.provenance.url, 'https://news.example/story')
  assert.equal(control.route.provenance.lastReadAt, null)
  assert.match(control.route.provenance.text, /printed on the cited page \(news\.example\), read when the scan ran/)
})
