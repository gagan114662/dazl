// A contact / company record found by enrichment attaches to a lead only when it AGREES with the lead on the company domain or on the
// place (city level for New York City / London, reusing placeAgreement). The same-name Pico Rivera, CA practice must not attach to a New
// York lead. Stubbed Apollo / PDL responses and invented companies; no network, no credits, no keys beyond test fixtures.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { enrichLeadContacts } from '../lib/enrich/index.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors, saveCredential, enrichmentsForLeads } from '../lib/connectors/store.ts'

const master = randomBytes(32)
const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
const NYC_ICP = JSON.stringify({ summary: 'NYC dental', where: ['New York City'], who: ['Practice manager'], signals: [] })

function seed(opts: { domain: string | null; icp?: string | null }) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(opts.icp === undefined ? NYC_ICP : opts.icp, jobId)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url, fit, intent, action, why) VALUES ('lead1', ?, '', 'Invented Dental', ?, 'opened a new practice', 'https://x.example/1', 4, 3, 4, 'New dental practice in Sunnyside.')").run(jobId, opts.domain)
  return { db, jobId, lead: { id: 'lead1', company: 'Invented Dental', company_domain: opts.domain } }
}
const apollo = (org: Record<string, unknown> | null, people: Record<string, unknown>[] = [{ name: 'Invented Person', title: 'Practice Manager', linkedin_url: 'https://profiles.example/person' }]) => (async (url: RequestInfo | URL) => {
  const u = String(url)
  if (u.includes('organizations/enrich')) return ok(org ? { organization: org } : {})
  if (u.includes('mixed_people')) return ok({ people })
  return new Response('no', { status: 404 })
}) as never
const rows = (db: Database.Database) => (enrichmentsForLeads(db, 'u1', ['lead1']).lead1 ?? []).filter(e => e.kind !== 'contact_rejected').map(e => `${e.kind}:${e.value}`)   // what was ATTACHED (refusal reasons are separate rows)

for(const connector of ['apollo','pdl'])test(`REVIEW ${connector}: same name-probed companydomain does not excuse explicit conflicting employer city`,async()=>{const s=seed({domain:'invented-dental.example'});s.db.prepare("UPDATE leads SET evidence_excerpt='Opened 120 Court Street, Brooklyn, NY 11201' WHERE id='lead1'").run();saveCredential(s.db,'u1',`enrich:${connector}`,'test-invented-key-1234',master);const fetchImpl=connector==='apollo'?apollo({name:'Invented Dental',website_url:'https://invented-dental.example',city:'Pico Rivera',state:'California',country:'United States',estimated_num_employees:12},[{name:'Invented Contact',organization:{name:'Invented Dental',primary_domain:'invented-dental.example'}}]):(async()=>ok({data:[{full_name:'Invented Contact',job_company_website:'invented-dental.example',job_company_location_locality:'pico rivera',job_company_location_region:'california',job_company_location_country:'united states'}]}))as never;await enrichLeadContacts(s.db,'u1',s.jobId,[s.lead],{fetchImpl,master});assert.deepEqual(rows(s.db),[],'explicit wrong-city employer must be withheld');s.db.close()})
