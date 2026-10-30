// Acceptance transcript for the #346 contact-identity fixes. STUBBED: invented companies, Apollo answered from a stub, no network, no credits.
// Run:  cd web && SITECRAWL_ENABLED=0 NEWS_SEARCH_ENABLED=0 node --experimental-strip-types --import ./test/helpers/net-fence.ts scripts/acceptance-346.mts
// Every line is "<scenario> -> <what the code did>", from the real functions (enrichLeadContacts, contactAgreement, snapshotLeads), not from assertions on mocks.
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { enrichLeadContacts } from '../lib/enrich/index.ts'
import { contactAgreement } from '../lib/scan/contact-agreement.ts'
import { snapshotLeads } from '../lib/scan/completion.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors, saveCredential, addEnrichment, enrichmentsForLeads } from '../lib/connectors/store.ts'

const master = randomBytes(32), out: string[] = []
const say = (s: string) => { out.push(s); console.log(s) }
const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
const NYC = JSON.stringify({ summary: 'NYC dental', where: ['New York City'], who: ['Practice manager'], signals: [] })

function world(domain: string | null) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(NYC, jobId)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url, event_date, confidence, fit) VALUES ('lead1', ?, '', 'Smile Avenue Dental', ?, 'opened a new practice', 'https://news.example/smile', '2026-10-12', 80, 4)").run(jobId, domain)
  saveCredential(db, 'u1', 'enrich:apollo', 'test-apollo-key-1234', master)
  return { db, jobId, lead: { id: 'lead1', company: 'Smile Avenue Dental', company_domain: domain } }
}
const apollo = (org: Record<string, unknown>) => (async (u: RequestInfo | URL) => String(u).includes('organizations/enrich') ? ok({ organization: org }) : ok({ people: [{ name: 'Sophia Rozov', title: 'Practice Manager', linkedin_url: 'https://profiles.example/sr', organization: { name: 'Smile Avenue Dental', primary_domain: String(org.website_url).replace(/^https?:\/\//, '') } }] })) as typeof fetch
async function attach(label: string, domain: string | null, org: Record<string, unknown>) {
  const w = world(domain)
  await enrichLeadContacts(w.db, 'u1', w.jobId, [w.lead], { fetchImpl: apollo(org), master })
  const rows = enrichmentsForLeads(w.db, 'u1', ['lead1']).lead1 ?? []
  const kept = rows.filter(r => r.kind === 'contact' || r.kind === 'person').map(r => r.value)
  const refused = rows.filter(r => r.kind === 'contact_rejected').map(r => r.value)
  say(`${label} -> ${kept.length ? `ATTACHED ${JSON.stringify(kept)}` : 'NOT attached (contact stays empty)'}${refused.length ? `; reason: ${refused[0]}` : ''}`)
}

say('== 1. Same-name practice in another state (the live-QA Pico Rivera case) ==')
await attach('Apollo record: Smile Avenue Dental Group, Pico Rivera CA, lead has no domain', null, { name: 'Smile Avenue Dental Group', website_url: 'https://smileavenuedental.com', city: 'Pico Rivera', state: 'California', country: 'United States' })
await attach('Apollo record: Smile Avenue Dental, New York NY, lead has no domain (control)', null, { name: 'Smile Avenue Dental', website_url: 'https://smileavenuedental.com', city: 'New York', state: 'New York', country: 'United States' })
await attach('Apollo record on a DIFFERENT domain than the lead\'s (same city)', 'smileavenuedental.com', { name: 'Smile Avenue Dental', website_url: 'https://smileavenue-dental.io', city: 'New York', state: 'New York', country: 'United States' })

say('\n== 2. A domain that only agrees with itself is not identity (guessed/legacy domain) vs an established one ==')
const LEAD = { company_domain: 'smileavenuedental.com', where: ['New York City'], evidence: 'Smile Avenue Dental opened at 57 W 57th St, New York' }
const REC = { domain: 'smileavenuedental.com', place: 'Pico Rivera, CA', address: '8000 Whittier Blvd, Pico Rivera, CA 90660' }
say(`guessed domain, record states Pico Rivera CA -> ${JSON.stringify(contactAgreement({ ...LEAD, domainEstablished: false }, REC))}`)
say(`ESTABLISHED domain (cited page host / user-confirmed), same record -> ${JSON.stringify(contactAgreement({ ...LEAD, domainEstablished: true }, REC))}`)
say(`guessed domain, record states New York NY -> ${JSON.stringify(contactAgreement({ ...LEAD, domainEstablished: false }, { domain: 'smileavenuedental.com', place: 'New York, NY' }))}`)

say('\n== 3. Completion counts only confirmed domains and real calendar days ==')
function snap(date: string, domain: string | null, check = false) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' }); db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(NYC, jobId)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url, event_date, confidence, fit, score) VALUES ('lead1', ?, '', 'Smile Avenue Dental', ?, 's', 'https://news.example/x', ?, 80, 4, 70)").run(jobId, domain, date)
  if (check && domain) addEnrichment(db, 'u1', 'lead1', { connector: 'sitecrawl', kind: 'domain_check', value: `${domain}|homepage_names_company_place_agrees`, label: null, confidence: null, source_url: `https://${domain}/`, source_date: '2026-10-20', retrieved_at: 0 })
  const s = snapshotLeads(db, 'u1', jobId)[0]; return `date=${s.date} domain=${s.domain}`
}
say(`event date 2026-02-31 (not a real day) -> ${snap('2026-02-31', null)}`)
say(`event date 2026-10-12, populated but unvalidated domain 'wrong-namesake.example' -> ${snap('2026-10-12', 'wrong-namesake.example')}`)
say(`event date 2026-10-12, domain with a recorded homepage check -> ${snap('2026-10-12', 'smileavenuedental.com', true)}`)
