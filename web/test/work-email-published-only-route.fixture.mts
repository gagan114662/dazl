// Strict-origin work email through the real route, isolated from the shared staging fixture.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './helpers/tenant-route-db.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { GET as WE_GET, POST as WE_POST } from '../app/api/leads/[lead]/work-email/route.ts'
import { setTestAddresses } from '../lib/outreach/sequences.ts'
import { TEST_INBOX } from '../lib/outreach/service.ts'
import { saveCredential, setEnrichFallback } from '../lib/connectors/store.ts'
import { createJob } from '../lib/scan/store.ts'
import { qaClaudeOnlyBudget } from '../lib/scan/qa-provider-policy.ts'
import { workEmailPageRead, type WorkEmailRow } from '../lib/people/work-email.ts'
import { recordEmailGuesses } from '../lib/people/email-pattern.ts'

let fetches = 0
globalThis.fetch = (async () => { fetches++; throw new Error('Unexpected network call') }) as typeof fetch
const master = randomBytes(32)
process.env.DAZL_MASTER_KEY = master.toString('base64')
const A = { id: 'A', business_name: 'Acme' }, B = { id: 'B', business_name: 'Beta' }
const hdr = { 'content-type': 'application/json', origin: 'http://localhost', host: 'localhost' }
const STAGING = { DAZL_ENV: 'staging', DAZL_STAGING_FAKE_PDL: '1', DAZL_STAGING_FAKE_ZEROBOUNCE: '1', EMAIL_GUESS_ENABLED: '1', EMAIL_VERIFY_DAILY_CAP: '5' }
const setEnv = (on: boolean) => { for (const [k, v] of Object.entries(STAGING)) { if (on) process.env[k] = v; else delete process.env[k] } }

function build(verbose?: (sql?: unknown) => void) {
  const db = new Database(':memory:', { verbose }); migrateAllSqlite(db)
  setTestAddresses(db, 'A', [TEST_INBOX])
  saveCredential(db, 'A', 'enrich:pdl', 'staging-fake-pdl-any-string-1036', master)
  saveCredential(db, 'A', 'enrich:apollo', 'real-looking-apollo-key-9999', master) // never called for the fixture lead
  setEnrichFallback(db, 'A', true)
  setScanDb(db); process.env.OUTREACH_TEST_TENANT_ID = 'A'
  return db
}

test('strict-origin work email route serves published-only GET/POST without exposing legacy broker data or fetching', async () => {
  const sql: string[] = []
  const db = build(line => { if (typeof line === "string") sql.push(line) }); setUser(A); setEnv(false)
  // Real provider transport, if reached, must hit the fetch trap. No staging fake.
  const verifierEnv = { EMAIL_GUESS_ENABLED: '1', EMAIL_VERIFY_DAILY_CAP: '5', EMAIL_VERIFY_MONTHLY_CAP: '100', ZEROBOUNCE_API_KEY: 'synthetic-zerobounce-key' }
  const envBefore = Object.fromEntries(Object.keys(verifierEnv).map(k => [k, process.env[k]]))
  Object.assign(process.env, verifierEnv)
  try {
    const site = 'harbordental.example', target = 'Dana Lee|Practice Manager', lead = randomBytes(12).toString('hex')
    const email = `dana.lee@${site}`, bio = `https://${site}/team`, now = Math.floor(Date.now() / 1000)
    const job = createJob(db, 'A', { business_name: 'Seller', industry: 'dental', location: 'New York' })
    db.prepare("UPDATE scan_jobs SET status = 'running', icp = ?, run_budget = ? WHERE id = ?").run(JSON.stringify({ who: ['Practice Manager'], where: ['New York, NY'] }), qaClaudeOnlyBudget(null), job)
    db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url, confidence) VALUES (?, ?, '', 'Harbor Dental', ?, 'hiring', ?, 80)").run(lead, job, site, bio)
    const add = db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, source_url, source_date, retrieved_at) VALUES (?, ?, 'A', 'sitecrawl', ?, ?, ?, ?, '2026-11-19', ?)")
    add.run(randomBytes(12).toString('hex'), lead, 'domain', `${site}|evidence_own_domain`, 'domain-basis-v1:evidence_own_domain', bio, now)
    add.run(randomBytes(12).toString('hex'), lead, 'person', 'Dana Lee, Practice Manager', null, bio, now)
    db.prepare("INSERT INTO work_email_lookups (tenant_id, lead_id, target, status, provider, address, updated_at) VALUES ('A', ?, ?, 'unverified', 'apollo', ?, ?)").run(lead, target, `stale@${site}`, now)
    const params = { params: Promise.resolve({ lead }) }
    const url = `http://localhost/api/leads/${lead}/work-email`
    const get = () => WE_GET(new NextRequest(url), params)
    const post = (chosen = target) => WE_POST(new NextRequest(url, { method: 'POST', body: JSON.stringify({ target: chosen }), headers: hdr }), params)
    const staleTarget = 'Dana Lee|Old Title'
    db.prepare("INSERT INTO work_email_lookups (tenant_id, lead_id, target, status, provider, address, source_url, updated_at) VALUES ('A', ?, ?, 'published', 'site', ?, ?, ?)").run(lead, staleTarget, `old@${site}`, 'http://wrong.example/old', now)
    const list = (tenant = 'A') => workEmailPageRead(db, tenant, [{ id: lead }]).lookups[lead] ?? []
    const tracked = fetches
    const ownGet = await get()
    assert.equal(ownGet.status, 200)
    assert.deepEqual(await ownGet.json(), { providers: { apollo: false, pdl: false, pdlNeedsOptIn: false, mailboxCheck: false, publishedOnly: true }, lookups: [], guesses: [] })
    assert.deepEqual(list(), [], 'page preloads no legacy published cache')
    const absent = await post()
    assert.equal(absent.status, 200)
    const absentView = await absent.json()
    assert.equal(absentView.status, 'not_found')
    assert.equal(absentView.lookup.address, null)
    assert.equal(absentView.guess, undefined)
    db.prepare("INSERT INTO email_candidates (tenant_id, lead_id, person, address, format, tier, source_url) VALUES ('A', ?, 'Dana Lee, Practice Manager', ?, 'published', 'published', ?)").run(lead, email, `http://${site}/team`)
    assert.deepEqual((await (await get()).json()).lookups, [], 'an HTTP candidate is not first-party proof')
    assert.deepEqual(list(), [])
    assert.equal((await (await post()).json()).status, 'not_found')
    db.prepare("DELETE FROM email_candidates WHERE lead_id = ?").run(lead)
    recordEmailGuesses(db, 'A', lead, site, [], ['Dana Lee, Practice Manager'], { env: verifierEnv, homeText: '1 Main St, New York, NY 10001', seen: [{ address: email, url: bio }] })
    const found = await post()
    assert.equal(found.status, 200)
    const foundView = await found.json()
    assert.equal(foundView.status, 'published')
    assert.deepEqual([foundView.lookup.address, foundView.lookup.source_url, foundView.lookup.checked_at], [email, bio, null])
    const reload = async () => (await (await get()).json()).lookups
    const evidence = (rows: WorkEmailRow[]) => rows.map(r => [r.target, r.status, r.provider, r.address, r.source_url, r.checked_at])
    assert.deepEqual(evidence(await reload()), evidence([foundView.lookup]), 'GET reload reconstructs published result')
    assert.deepEqual(evidence(list()), evidence([foundView.lookup]), 'page preload agrees with POST')
    assert.deepEqual(list('B'), [])
    const more = Array.from({ length: 10 }, () => randomBytes(12).toString('hex'))
    const insertLead = db.prepare("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url) VALUES (?, ?, '', 'Harbor Dental', 'hiring', ?)")
    for (const id of more) insertLead.run(id, job, bio)
    const projectionQueries = (ids: string[]) => {
      sql.length = 0
      workEmailPageRead(db, 'A', ids.map(id => ({ id })))
      assert.equal(sql.some(q => /FROM work_email_lookups/i.test(q)), false, 'strict preload never reads legacy lookups')
      return sql.filter(q => /FROM (?:leads l JOIN scan_jobs|lead_enrichments|email_candidates)\b/i.test(q)).length
    }
    assert.equal(projectionQueries([lead]), 3)
    assert.equal(projectionQueries([lead, ...more]), 3, 'queries are batched, not per lead')

    db.prepare("UPDATE scan_jobs SET icp = ? WHERE id = ?").run(JSON.stringify({ who: ['Practice Manager', 'Office Manager'], where: ['New York, NY'] }), job)
    add.run(randomBytes(12).toString('hex'), lead, 'person', 'Dána Lee, Office Manager', null, bio, now)
    assert.deepEqual(await reload(), [], 'normalized namesake prevents GET projection')
    assert.deepEqual(list(), [])
    const ambiguous = await (await post()).json()
    assert.equal(ambiguous.status, 'not_found', 'namesake also blocks direct POST')
    assert.match(ambiguous.lookup.detail, /multiple eligible people share this name/i)
    assert.equal((await (await post('Dána Lee|Office Manager')).json()).status, 'not_found', 'neither eligible title gets the shared address')
    setUser(B)
    assert.equal((await get()).status, 404)
    assert.equal((await post()).status, 404)
    assert.equal(fetches, tracked)
    assert.deepEqual(db.prepare("SELECT status,address FROM work_email_lookups WHERE lead_id = ? AND target = ?").get(lead, target), { status: 'unverified', address: `stale@${site}` })
  } finally {
    for (const [k, v] of Object.entries(envBefore)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
})
