// #1772: Home's "leads from N companies" line counted companies by name key alone, while Home's funnel and the
// Leads checked page count the way home-ready does (lib/outreach/home-ready.ts): a company is the same company
// when its leads share a domain OR a normalised name. Two name variants of one company that share a domain
// counted twice in home-results (72 vs 71 on the QA account). One rule everywhere: the count below is the
// number home-ready's keying produces for the same leads.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { bothEngines } from './helpers/engines.ts'
import { homeResults } from '../lib/outreach/home-results.ts'
import { test } from 'node:test'

const NOW = 1_800_000_000, DAY = 86400
const IN = NOW - 5 * DAY

async function seed(db: import('../lib/db/client.ts').Db) {
  const J = 'j'.repeat(24)
  await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, created_at) VALUES (?, 'A', 'x', 'test', 'test', 'running', ?)", [J, IN])
  const lead = (id: string, company: string, domain: string | null) => db.run(
    "INSERT INTO leads (id, scan_job_id, company, company_domain, signal, source_url, signal_kind, created_at) VALUES (?, ?, ?, ?, 'hiring an SDR', 'https://news.example/a', 'hiring', ?)",
    [id, J, company, domain, IN])
  // one company under two name variants, tied together by the shared domain
  await lead('n1', 'Northwind Traders', 'northwind.example')
  await lead('n2', 'Northwind', 'northwind.example')
  // one company under two name variants, tied by the normalised name alone (control: both rules agree)
  await lead('c1', 'Contoso Ltd', null)
  await lead('c2', 'Contoso', null)
  // a distinct company
  await lead('f1', 'Fabrikam', 'fabrikam.example')
  // a name made only of legal-form words (its name key is empty), tied to its company by the domain
  await lead('a1', 'LLC', 'acme.example')
  await lead('a2', 'Acme', 'acme.example')
  // the #1760 fallback without a domain: a legal-form-only name keys on the trimmed lowercased name
  await lead('i1', 'Inc', null)
  await lead('i2', 'INC', null)
  // no company name and no domain (a person lead): not a company, only an unnamed lead
  await db.run(
    "INSERT INTO leads (id, scan_job_id, company, name, company_domain, signal, source_url, signal_kind, created_at) VALUES (?, ?, '', 'Pat', NULL, 'hiring an SDR', 'https://news.example/a', 'hiring', ?)",
    ['u1', J, IN])
}

bothEngines('#1772: companies are counted the home-ready way - same domain or same normalised name is one company', async ({ db }) => {
  await seed(db)
  const r = await homeResults(db, 'A', NOW)
  assert.equal(r.tiles.leads, 10, 'all ten leads are shown')
  // Northwind (2 leads, 1 company), Contoso (2 leads, 1), Fabrikam (1), Acme (2 leads, 1), Inc (2 leads, 1) = 5 companies.
  // Name-key-only counting says 6 for the first seven: 'northwind traders' + 'northwind', 'contoso', 'fabrikam', 'llc' + 'acme'.
  assert.equal(r.companies, 5, 'companies counted by domain-or-name identity, the way home-ready and the funnel count')
  assert.equal(r.unnamed_leads, 1, 'the lead with no name and no domain is unnamed only, never a company')
})

test('#1772: the line under the by-signal table says leads from the same company count', () => {
  const src = readFileSync(new URL('../app/app/home-results.tsx', import.meta.url), 'utf8')
  assert.ok(src.includes('from ${r.companies}'), 'the by-signal line renders "leads from N companies" with the unified count')
})
