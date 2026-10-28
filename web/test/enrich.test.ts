import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { apolloOrgEnrich, apolloPeopleSearch, EnrichError } from '../lib/enrich/apollo.ts'
import { pdlPeopleSearch } from '../lib/enrich/pdl.ts'
import { enrichLeadContacts } from '../lib/enrich/index.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors, saveCredential, recentAudit, enrichmentsForLeads } from '../lib/connectors/store.ts'

const master = randomBytes(32)
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

const ORG_RESP = { organization: { name: 'Acme Inc', estimated_num_employees: 86, industry: 'Computer Software', founded_year: 2019, website_url: 'https://acme.com', linkedin_url: 'https://linkedin.com/company/acme' } }
const PEOPLE_RESP = { people: [
  { name: 'Jane Doe', title: 'VP Sales', linkedin_url: 'https://linkedin.com/in/jane', email: 'jane@acme.com', phone_numbers: ['+1 555 0100'] },
  { name: 'John Roe', title: null, linkedin_url: null },
] }

test('apolloOrgEnrich: posts domain to /organizations/enrich with x-api-key, maps firmographics', async () => {
  const seen: { url: string; key: string | null; body: string }[] = []
  const f = await apolloOrgEnrich('test-apollo-key', { domain: 'acme.com' }, (async (url: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(url), key: (init?.headers as Record<string, string>)['x-api-key'] ?? null, body: String(init?.body) })
    return ok(ORG_RESP)
  }) as never)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].url, 'https://api.apollo.io/api/v1/organizations/enrich')
  assert.equal(seen[0].key, 'test-apollo-key')
  assert.match(seen[0].body, /"domain":"acme.com"/)
  assert.deepEqual(f, { name: 'Acme Inc', employees: 86, industry: 'Computer Software', founded: 2019, website: 'https://acme.com', linkedin: 'https://linkedin.com/company/acme', place: null })
})

test('apolloPeopleSearch: uses the 0-credit search endpoint, never returns emails/phones', async () => {
  const seen: string[] = []
  const people = await apolloPeopleSearch('k', { name: 'Acme' }, (async (url: RequestInfo | URL, init?: RequestInit) => {
    seen.push(String(url) + '|' + String(init?.body))
    return ok(PEOPLE_RESP)
  }) as never) as unknown as (Record<string, unknown>)[]
  assert.match(seen[0], /mixed_people\/api_search/)
  assert.match(seen[0], /q_organization_name/)
  assert.equal(people.length, 2)
  assert.equal(people[0].name, 'Jane Doe')
  // the raw response carried email + phone_numbers; the mapped person must not
  assert.ok(!('email' in people[0]) && !('phone_numbers' in people[0]))
})

test('apollo errors: 429 -> rate_limited, 401 -> auth, 500 -> upstream', async () => {
  for (const [status, code] of [[429, 'rate_limited'], [401, 'auth'], [500, 'upstream']] as const) {
    try {
      await apolloOrgEnrich('k', { domain: 'x.com' }, (async () => new Response('no', { status })) as never)
      assert.fail('should have thrown')
    } catch (e) { assert.ok(e instanceof EnrichError); assert.equal((e as EnrichError).code, code) }
  }
})

test('pdlPeopleSearch: posts company term query with X-Api-Key, maps names/titles only', async () => {
  const seen: { url: string; key: string | null }[] = []
  const people = await pdlPeopleSearch('pdl-key', 'Acme', (async (url: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(url), key: (init?.headers as Record<string, string>)['X-Api-Key'] ?? null })
    return ok({ data: [{ full_name: 'Jane Doe', job_title: 'VP Sales', linkedin_url: 'https://linkedin.com/in/jane', emails: ['jane@acme.com'] }] })
  }) as never) as unknown as (Record<string, unknown>)[]
  assert.equal(seen[0].url, 'https://api.peopledatalabs.com/v5/person/search')
  assert.equal(seen[0].key, 'pdl-key')
  assert.equal(people[0].name, 'Jane Doe')
  assert.ok(!('emails' in people[0]))
  await assert.rejects(pdlPeopleSearch('k', 'Acme', (async () => new Response('no', { status: 429 })) as never), (e: unknown) => e instanceof EnrichError && e.code === 'rate_limited')
})

function seedLead() {
  const db = new Database(':memory:')
  migrateScan(db); migrateConnectors(db)
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(jobId)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url) VALUES ('lead1', ?, '', 'Acme', 'acme.com', 'hiring', 'https://x.com/1')").run(jobId)
  return { db, jobId, lead: { id: 'lead1', company: 'Acme', company_domain: 'acme.com' } }
}

test('enrichLeadContacts: no keys saved -> no outbound calls, no rows', async () => {
  const { db, jobId, lead } = seedLead()
  let calls = 0
  await enrichLeadContacts(db, 'u1', jobId, [lead], { fetchImpl: (async () => { calls++; return ok({}) }) as never, master })
  assert.equal(calls, 0)
  assert.equal((recentAudit(db, 'u1', 10) as unknown[]).length, 0)
})

test('enrichLeadContacts: apollo key -> firmographic + contact enrichments, audited, emails never stored', async () => {
  const { db, jobId, lead } = seedLead()
  saveCredential(db, 'u1', 'enrich:apollo', 'test-apollo-key-1234', master)
  const urls: string[] = []
  const fetchImpl = (async (url: RequestInfo | URL) => {
    const u = String(url); urls.push(u)
    if (u.includes('organizations/enrich')) return ok(ORG_RESP)
    if (u.includes('mixed_people')) return ok(PEOPLE_RESP)
    return new Response('no', { status: 404 })
  }) as never
  await enrichLeadContacts(db, 'u1', jobId, [lead], { fetchImpl, master })
  assert.deepEqual(urls.map(u => u.split('/api/v1/')[1].split('?')[0]), ['organizations/enrich', 'mixed_people/api_search'])
  const rows = enrichmentsForLeads(db, 'u1', ['lead1']).lead1
  const kinds = rows.map(r => `${r.connector}:${r.kind}`).sort()
  assert.deepEqual(kinds, ['enrich:apollo:contact', 'enrich:apollo:contact', 'enrich:apollo:firmographic'])
  const firmo = rows.find(r => r.kind === 'firmographic')!
  assert.match(firmo.value, /86 employees/)
  assert.match(firmo.value, /Computer Software/)
  assert.equal(firmo.source_url, 'https://linkedin.com/company/acme')
  const all = JSON.stringify(rows)
  assert.ok(!all.includes('jane@acme.com') && !all.includes('555 0100'))
  const st = (recentAudit(db, 'u1', 10) as { connector: string; status: string }[]).map(a => `${a.connector}:${a.status}`)
  assert.ok(st.includes('enrich:apollo:ok'))
})

test('enrichLeadContacts: pdl-only key -> pdl path used instead of apollo', async () => {
  const { db, jobId, lead } = seedLead()
  saveCredential(db, 'u1', 'enrich:pdl', 'test-pdl-key-5678', master)
  const urls: string[] = []
  await enrichLeadContacts(db, 'u1', jobId, [lead], { fetchImpl: (async (url: RequestInfo | URL) => {
    urls.push(String(url))
    return ok({ data: [{ full_name: 'Jane Doe', job_title: 'VP Sales', linkedin_url: 'https://linkedin.com/in/jane' }] })
  }) as never, master })
  assert.deepEqual(urls, ['https://api.peopledatalabs.com/v5/person/search'])
  const rows = enrichmentsForLeads(db, 'u1', ['lead1']).lead1
  assert.deepEqual(rows.map(r => r.connector), ['enrich:pdl'])
})

test('enrichLeadContacts: rejected key audits auth and stops the pass (no burn on later leads)', async () => {
  const { db, jobId, lead } = seedLead()
  saveCredential(db, 'u1', 'enrich:apollo', 'bad-key-000000000000', master)
  let calls = 0
  await enrichLeadContacts(db, 'u1', jobId, [lead, { id: 'lead2', company: 'Beta', company_domain: null }], { fetchImpl: (async () => { calls++; return new Response('no', { status: 401 }) }) as never, master })
  assert.equal(calls, 1)
  const st = (recentAudit(db, 'u1', 10) as { status: string }[]).map(a => a.status)
  assert.deepEqual(st, ['auth'])
})

test('enrichJobSignals wiring: saved apollo key adds apollo enrichments inside the scan waterfall', async () => {
  const { enrichJobSignals } = await import('../lib/signals/index.ts')
  const { db, jobId } = seedLead()
  saveCredential(db, 'u1', 'enrich:apollo', 'test-apollo-key-1234', master)
  process.env.DAZL_MASTER_KEY = master.toString('base64')
  try {
    const fetchImpl = (async (url: RequestInfo | URL) => {
      const u = String(url)
      if (u.includes('organizations/enrich')) return ok(ORG_RESP)
      if (u.includes('mixed_people')) return ok(PEOPLE_RESP)
      return new Response('no', { status: 404 })
    }) as never
    await enrichJobSignals(db, 'u1', jobId, { fetchImpl })
    const rows = enrichmentsForLeads(db, 'u1', ['lead1']).lead1 ?? []
    assert.ok(rows.some(r => r.connector === 'enrich:apollo' && r.kind === 'firmographic'))
  } finally { delete process.env.DAZL_MASTER_KEY }
})

test('enrichLeadContacts: lead without a domain reuses the org-discovered domain for people search', async () => {
  const db = new Database(':memory:')
  migrateScan(db); migrateConnectors(db)
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(jobId)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url) VALUES ('lead1', ?, '', 'The Jackson Laboratory (JAX)', NULL, 'hiring', 'https://x.com/1')").run(jobId)
  saveCredential(db, 'u1', 'enrich:apollo', 'test-apollo-key-1234', master)
  const bodies: string[] = []
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(String(init?.body))
    const u = String(url)
    if (u.includes('organizations/enrich')) return ok({ organization: { name: 'The Jackson Laboratory', estimated_num_employees: 3000, industry: 'research', founded_year: 1929, website_url: 'https://www.jax.org', linkedin_url: 'https://linkedin.com/company/jacksonlaboratory' } })
    return ok({ people: [{ name: 'Jane Doe', title: 'CIO', linkedin_url: null }] })
  }) as never
  await enrichLeadContacts(db, 'u1', jobId, [{ id: 'lead1', company: 'The Jackson Laboratory (JAX)', company_domain: null }], { fetchImpl, master })
  const peopleReq = bodies.find(b => b.includes('per_page'))!
  assert.match(peopleReq, /"q_organization_domains":"jax.org"/) // www stripped, org-discovered domain used
  assert.ok(!peopleReq.includes('q_organization_name'))
})
