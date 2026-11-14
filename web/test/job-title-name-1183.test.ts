// #1183: a job title stored as a person. Real case: https://www.armstrongteasdale.com/people/ (read 2026-11-13) carries a title FILTER whose
// options are job titles in <li class="datalist__option"> lines; "Litigation Specialist" followed by "Managing Partner" was stored as the
// person "Litigation Specialist, Managing Partner", shown as "named on the company's own website", and Find work email was offered for it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { createJob } from '../lib/scan/store.ts'
import { saveCredential } from '../lib/connectors/store.ts'
import { extractPeople } from '../lib/connectors/sitecrawl.ts'
import { looksLikeJobTitle } from '../lib/people/job-title-name.ts'
import { contactsFromEnrichments } from '../lib/people/rank.ts'
import { workEmailTargets } from '../lib/people/work-email-eligible.ts'
import { findWorkEmail } from '../lib/people/work-email.ts'

const opt = (n: number, t: string) => `<li class="datalist__option" data-value="${n}"><span class="datalist__option__inner"><span class="datalist__option__text">${t}</span></span></li>`
const FILTER = ['Immigration Specialist', 'Intellectual Property Specialist', 'International Docket Administrator', 'Legal Project Manager', 'Litigation Specialist', 'Managing Partner', 'Of Counsel', 'Paralegal', 'Partner'].map((t, i) => opt(50 + i, t)).join('')
const PROSE = '<p>Armstrong Teasdale is a law firm with offices across the country. Our lawyers advise companies on disputes, transactions and regulatory matters, and we care about the clients and communities we serve every day.</p>'
const PAGE = (extra = '') => `<html><body>${PROSE}<div class="datalist"><ul class="datalist__options">${FILTER}</ul></div>${extra}</body></html>`
const URL_ = 'https://www.armstrongteasdale.com/people/'
const ROLES = 'Managing Partner; Partner'

test('#1183 looksLikeJobTitle: titles and practice words are refused; real names (accents, apostrophes, role-like given names) never are', () => {
  for (const t of ['Litigation Specialist', 'Managing Partner', 'Of Counsel', 'Legal Project Manager', 'International Docket Administrator', 'Intellectual Property Specialist', 'Immigration Specialist', 'Senior Associate', 'Chief Marketing Officer', 'Real Estate Broker', 'Customer Success Manager', 'Human Resources', 'Business Development'])
    assert.equal(looksLikeJobTitle(t), true, t)
  for (const n of ['Jeanne Hammerstrom', 'Nora Wall', "Emilia D'Mello", 'Brent Richardson', 'Jordan Hammond', 'Maya Thornton', 'Dana Whitcombe', 'Corinne Wright', 'Anna María López-Pérez', 'Chase Brooks', 'Grant Miller', 'Taylor Reed', 'Joy Lawyer-Smith', 'Joy Manager', 'Will Owner', 'Joe Partner', 'Kim Staff', 'Pat Principal'.split('-')[0] + ' Hart'])
    assert.equal(looksLikeJobTitle(n), false, n)
  assert.equal(looksLikeJobTitle(null), false); assert.equal(looksLikeJobTitle(''), false)
})

test('#1183 the people reader stores no person from a title filter; real people on the same page are still stored', () => {
  assert.deepEqual(extractPeople(PAGE(), URL_, ROLES), [], 'the real page shape: nobody')
  const real = extractPeople(PAGE('<div class="person"><h3>Jane Doe</h3><p>Managing Partner</p></div>'), URL_, ROLES)
  assert.deepEqual(real.map(p => p.value), ['Jane Doe, Managing Partner'])
})

test('#1183 a row stored earlier ("Litigation Specialist, Managing Partner") is not listed, ranked or offered; a real person next to it is', () => {
  const row = (value: string) => ({ connector: 'sitecrawl', kind: 'person', value, label: null, source_url: URL_, source_date: '2026-11-13', confidence: null, retrieved_at: 1_794_000_000 })
  const rows = [row('Litigation Specialist, Managing Partner'), row('Jane Doe, Managing Partner')]
  assert.deepEqual(contactsFromEnrichments(rows, ROLES, 1_794_000_000_000).map(p => p.name), ['Jane Doe'])
  const site = { text: 'x', state: 'fact' as const, site: 'armstrongteasdale.com' }
  assert.deepEqual(workEmailTargets(rows, ROLES, 1_794_000_000_000, site).map(p => p.name), ['Jane Doe'])
  assert.deepEqual(workEmailTargets([rows[0]], ROLES, 1_794_000_000_000, site), [], 'no Find work email for a title')
})

test('#1183 the server refuses the click on a stored title row before any provider call', async () => {
  const db = new Database(':memory:'); migrateAllSqlite(db); const master = randomBytes(32)
  const job = createJob(db, 'A', { business_name: 'Seller', industry: 'legal', location: 'St. Louis' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify({ summary: 'law firms', who: ['Managing Partner'], where: ['St. Louis, MO'], signals: [] }), job)
  const id = 'c3'.repeat(12)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, confidence) VALUES (?, ?, '', 'Armstrong Teasdale', 'opened an office', 'https://www.armstrongteasdale.com/news', 80)").run(id, job)
  const add = (kind: string, value: string, label: string | null) => db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES (?, ?, 'A', 'sitecrawl', ?, ?, ?, 70, ?, '2026-11-13', 1794000000)").run(randomBytes(12).toString('hex'), id, kind, value, label, URL_)
  add('domain', 'armstrongteasdale.com|evidence_own_domain', 'domain-basis-v1:evidence_own_domain'); add('person', 'Litigation Specialist, Managing Partner', null)
  saveCredential(db, 'A', 'enrich:apollo', 'test-apollo-key-1234', master)
  const calls: string[] = []
  const r = await findWorkEmail(db, 'A', id, 'Litigation Specialist|Managing Partner', { master, now: 1_794_000_000, fetchImpl: (async (u: RequestInfo | URL) => { calls.push(String(u)); throw new Error('no provider call expected') }) as typeof fetch })
  assert.equal(r.status, 'not_eligible'); assert.deepEqual(calls, [])
})

test('#1183 the module is plain ASCII (a raw combining-mark range in a regex was mis-decoded by the rendered-check bundler and broke the Leads page in the browser) and accents do not matter', async () => {
  const { readFileSync } = await import('node:fs')
  assert.ok(!/[^\x00-\x7f]/.test(readFileSync(new URL('../lib/people/job-title-name.ts', import.meta.url), 'utf8')), 'non-ASCII character in job-title-name.ts')
  assert.equal(looksLikeJobTitle('José García'), false)
  assert.equal(looksLikeJobTitle('Sénior Mánager'), true)
})

test('#1183 an UNLISTED title in a filter control cannot pair into a person (cut by context, not vocabulary); role-like surnames are kept', () => {
  const filter = ['Managing Member', 'Managing Partner', 'Diretor Comercial', 'Gerente de Vendas'].map((t, i) => opt(70 + i, t)).join('')
  const page = `<html><body>${PROSE}<div class="datalist"><ul class="datalist__options">${filter}</ul></div></body></html>`
  assert.deepEqual(extractPeople(page, URL_, 'Managing Partner; Gerente de Vendas'), [], 'Managing Member + Managing Partner / Diretor Comercial + Gerente de Vendas: nobody')
  const select = `<html><body>${PROSE}<select><option>Managing Member<option>Managing Partner</select></body></html>`
  assert.deepEqual(extractPeople(select, URL_, ROLES), [], 'an unclosed-option select is page chrome too')
  assert.equal(looksLikeJobTitle('Joy Manager'), false); assert.equal(looksLikeJobTitle('Pat Principal'), false)
  const rows = ['Joy Manager, Managing Partner', 'Will Owner, Managing Partner'].map(value => ({ connector: 'enrich:apollo', kind: 'person', value, label: null, source_url: URL_, source_date: '2026-11-13', confidence: null, retrieved_at: 1_794_000_000 }))
  assert.deepEqual(contactsFromEnrichments(rows, ROLES, 1_794_000_000_000).map(p => p.name).sort(), ['Joy Manager', 'Will Owner'], 'stored provider people with role-like surnames survive')
})
