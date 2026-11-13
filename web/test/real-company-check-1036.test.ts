// #1036 live-check enabler (LIVE-FIRST rule A2): on staging, the test tenant adds ONE real company and the REAL site crawl reads it,
// so Find work email can be checked live on real pages at $0. Here the pages are served by a stub Get with the markup of a real
// brokerage team page (synthetic names and domain); the crawl, identity, people, published tier and lookup are the production code.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { setTestAddresses } from '../lib/outreach/sequences.ts'
import { TEST_INBOX } from '../lib/outreach/service.ts'
import { FixtureError } from '../lib/outreach/test-fixture.ts'
import type { Get } from '../lib/connectors/sitecrawl.ts'
import { findWorkEmail } from '../lib/people/work-email.ts'
import { workEmailCopy } from '../lib/people/work-email-eligible.ts'
import { deleteRealCompanyChecks, parseRealCheckInput, realCheckAvailable, runRealCompanyCheck } from '../lib/scan/real-company-check.ts'

const T = 'real-check-tenant'
const STAGING = { DAZL_ENV: 'staging' }
const PROSE = '<p>Bluebonnet Realty is a boutique real estate firm servicing the Greater Austin area. We help buyers and sellers with every step of the process, and we care about the neighborhoods we work in and the people who live there.</p>'
const card = (name: string, email: string, role: string) => `<div class="team-member__container" data-search-string="${name} ${email}" data-tags="[]" > <a class="team-member__link" href="/agent/x"> <div class="team-member__info"> <span class="team-member__name">${name}</span> <span class="team-member__role">${role}</span> </div> </a> </div>`
const html = (b: string) => `<html><body>${b}</body></html>`
const PAGES: Record<string, string> = {
  '/robots.txt': 'User-agent: *\nAllow: /',
  '/': html(`${PROSE}<p>Bluebonnet Realty, 100 Example Ave, Cedar Park, TX 78613</p><a href="/team">Our Team</a>`),
  '/team': html(`${PROSE}${card('Maya Thornton', 'maya@bluebonnetrealty.com', 'Real Estate Broker | Owner')}${card('Owen Pike', 'owen@bluebonnetrealty.com', 'Real Estate Agent')}`),
}
const get: Get = async url => { const p = PAGES[new URL(url).pathname]; return p !== undefined ? { status: 200, body: p, finalUrl: url } : { status: 404, body: '', finalUrl: url } }
const INPUT = { company: 'Bluebonnet Realty', url: 'https://bluebonnetrealty.com/', who: 'Broker; Owner' }
function setup() { const db = new Database(':memory:'); migrateAllSqlite(db); process.env.OUTREACH_TEST_TENANT_ID = T; setTestAddresses(db, T, [TEST_INBOX]); return db }

test('#1036 real-company check: staging test tenant only; input validated (http(s) host, 1-4 roles, no IP / port)', async () => {
  const db = setup()
  assert.equal(realCheckAvailable(db, T, {}), false); assert.equal(realCheckAvailable(db, T, STAGING), true); assert.equal(realCheckAvailable(db, 'other', STAGING), false)
  await assert.rejects(runRealCompanyCheck(db, T, INPUT, { env: {}, get, gapMs: 0 }), (e: unknown) => e instanceof FixtureError && e.code === 'staging_only')
  await assert.rejects(runRealCompanyCheck(db, 'other', INPUT, { env: STAGING, get, gapMs: 0 }), (e: unknown) => e instanceof FixtureError && e.code === 'test_tenant_only')
  assert.equal((db.prepare('SELECT count(*) AS n FROM leads').get() as { n: number }).n, 0, 'nothing created by a refusal')
  assert.deepEqual(parseRealCheckInput(INPUT), INPUT)
  for (const bad of [null, {}, { ...INPUT, url: 'ftp://x.com' }, { ...INPUT, url: 'http://10.0.0.1/' }, { ...INPUT, url: 'https://x.com:8080/' }, { ...INPUT, url: 'https://user:pw@x.com/' }, { ...INPUT, who: '' }, { ...INPUT, who: 'a;b;c;d;e' }, { ...INPUT, company: 'x' }])
    assert.equal(parseRealCheckInput(bad), null, JSON.stringify(bad))
})

test('#1036 real-company check end to end: real crawl settles the site and names the buyer; one click gives the published work email', async () => {
  const db = setup(); const calls: string[] = []
  const r = await runRealCompanyCheck(db, T, INPUT, { env: STAGING, get, gapMs: 0, now: Date.parse('2026-11-13T12:00:00Z') })
  assert.equal(r.site, 'bluebonnetrealty.com'); assert.deepEqual(r.people, ['Maya Thornton, Real Estate Broker | Owner'])
  const lead = db.prepare('SELECT company, contact, source_kind, signal FROM leads WHERE id = ?').get(r.leadId) as { company: string; contact: string | null; source_kind: string; signal: string }
  assert.deepEqual([lead.company, lead.contact, lead.source_kind], ['Bluebonnet Realty', null, 'staging_check']); assert.match(lead.signal, /Not a scan finding/)
  const w = await findWorkEmail(db, T, r.leadId, 'Maya Thornton|Real Estate Broker | Owner', { env: STAGING, now: 1_794_000_000, fetchImpl: (async (u: RequestInfo | URL) => { calls.push(String(u)); throw new Error('no provider call') }) as typeof fetch })
  assert.equal(w.status, 'published', JSON.stringify(w))
  const row = (w as { row: Parameters<typeof workEmailCopy>[0] }).row
  assert.deepEqual([row.address, row.source_url], ['maya@bluebonnetrealty.com', 'https://bluebonnetrealty.com/team']); assert.equal(workEmailCopy(row).headline, 'Published work email')
  assert.deepEqual(calls, [])
  assert.deepEqual(deleteRealCompanyChecks(db, T), { deleted: 1 })
  for (const t of ['leads', 'work_email_lookups', 'email_candidates']) assert.equal((db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n, 0, t)
})
