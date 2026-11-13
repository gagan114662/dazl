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
import { deleteRealCompanyChecks, parseRealCheckInput, realCheckAvailable, RealCheckNotRead, runRealCompanyCheck } from '../lib/scan/real-company-check.ts'
import { migrateAutopilot, newLeadsSql } from '../lib/outreach/autopilot.ts'
import { CALIBRATION_CANDIDATES_SQL } from '../lib/outreach/calibration.ts'

const T = 'real-check-tenant'
const STAGING = { DAZL_ENV: 'staging' }
const PROSE = '<p>Bluebonnet Realty is a boutique real estate firm servicing the Greater Austin area. We help buyers and sellers with every step of the process, and we care about the neighborhoods we work in and the people who live there.</p>'
const card = (name: string, email: string, role: string) => `<div class="team-member__container" data-search-string="${name} ${email}" data-tags="[]" > <a class="team-member__link" href="/agent/x"> <div class="team-member__info"> <span class="team-member__name">${name}</span> <span class="team-member__role">${role}</span> </div> </a> </div>`
const html = (b: string) => `<html><body>${b}</body></html>`
const PAGES: Record<string, string> = {
  '/robots.txt': 'User-agent: *\nAllow: /',
  '/': html(`${PROSE}<p>Bluebonnet Realty, 100 Example Ave, Cedar Park, TX 78613</p><a href="/team">Our Team</a><a href="/contact">Contact</a>`),
  '/team': html(`${PROSE}${card('Maya Thornton', 'maya@bluebonnetrealty.com', 'Real Estate Broker | Owner')}${card('Owen Pike', 'owen@bluebonnetrealty.com', 'Real Estate Agent')}`),
  '/contact': html(`${PROSE}<a href="mailto:office@bluebonnetrealty.com">Email the office</a>`),
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
  assert.equal(parseRealCheckInput({ ...INPUT, url: 'http://bluebonnetrealty.com/' })?.url, 'https://bluebonnetrealty.com/', 'http is read as https (the crawler reads https only)')
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

const now = () => Math.floor(Date.now() / 1000)
test('#1036 review R1: a real-company check lead is never an autopilot candidate, even when the crawl records the site\'s inbox', async () => {
  const db = setup(); migrateAutopilot(db)
  const r = await runRealCompanyCheck(db, T, INPUT, { env: STAGING, get, gapMs: 0 })
  assert.ok(db.prepare("SELECT 1 FROM lead_enrichments WHERE lead_id = ? AND connector = 'sitecrawl' AND kind = 'email'").get(r.leadId), 'precondition: the crawl recorded the office inbox')
  const cands = () => (db.prepare(newLeadsSql()).all(T, now() - 1e9, 0, T, T, T, now(), now()) as { id: string }[]).map(x => x.id)
  const calib = () => (db.prepare(CALIBRATION_CANDIDATES_SQL).all(T, 0, T) as { id: string }[]).map(x => x.id)
  assert.ok(!cands().includes(r.leadId), 'never drafted by autopilot'); assert.ok(!calib().includes(r.leadId), 'never a launch-calibration sample')
  db.prepare('UPDATE leads SET source_kind = NULL WHERE id = ?').run(r.leadId)
  assert.ok(cands().includes(r.leadId), 'control: the same lead as an ordinary lead IS a candidate, so the exclusion is what keeps it out')
  assert.ok(calib().includes(r.leadId), 'control (calibration)')
})

test('#1036 review R2: a crawl that reads nothing is a reported failure with the crawler\'s reason, not a silent success', async () => {
  const db = setup()
  const blocked: Get = async url => ({ status: 403, body: 'Forbidden', finalUrl: url })
  let reason = ''
  await assert.rejects(runRealCompanyCheck(db, T, INPUT, { env: STAGING, get: blocked, gapMs: 0 }), (e: unknown) => { reason = (e as RealCheckNotRead).reason; return e instanceof RealCheckNotRead })
  const audited = (db.prepare("SELECT status FROM connector_audit WHERE tenant_id = ? AND connector = 'sitecrawl' ORDER BY created_at DESC, id DESC LIMIT 1").get(T) as { status: string } | undefined)?.status
  assert.ok(audited, 'precondition: the crawler audited why it read nothing')
  assert.equal(reason, audited!.slice(0, 200), 'the reason is the crawler\'s own audit status, not a generic line')
  const nobody: Get = async url => { const p = new URL(url).pathname; return p === '/team' ? { status: 200, body: html(PROSE), finalUrl: url } : get(url) }
  await assert.rejects(runRealCompanyCheck(db, T, INPUT, { env: STAGING, get: nobody, gapMs: 0 }), (e: unknown) => e instanceof RealCheckNotRead && /names no one/.test(e.reason))
})

test('#1036 review R4: removing checks is refused while a crawl or a lookup runs, and touches only this tenant\'s checks', async () => {
  const db = setup()
  const r = await runRealCompanyCheck(db, T, INPUT, { env: STAGING, get, gapMs: 0 })
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES ('other-job', 'other-tenant', ?, 'staging check', 'staging check', 'done')").run('dazl real-company Find work email check (staging test)')
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES ('real-play', ?, 'Austin brokerages', 'real estate', 'Austin', 'done')").run(T)
  db.prepare("INSERT INTO work_email_lookups (tenant_id, lead_id, target, status, updated_at) VALUES (?, ?, 'Maya Thornton|Real Estate Broker | Owner', 'pending', ?)").run(T, r.leadId, now())
  assert.throws(() => deleteRealCompanyChecks(db, T), (e: unknown) => e instanceof FixtureError && e.code === 'check_in_flight')
  db.prepare('DELETE FROM work_email_lookups').run()
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES ('crawling', ?, 'dazl real-company Find work email check (staging test)', 'staging check', 'staging check', 'running')").run(T)
  assert.throws(() => deleteRealCompanyChecks(db, T), (e: unknown) => e instanceof FixtureError && e.code === 'check_in_flight', 'a crawl still running')
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = 'crawling'").run()
  assert.deepEqual(deleteRealCompanyChecks(db, T), { deleted: 2 })
  assert.deepEqual((db.prepare('SELECT id FROM scan_jobs ORDER BY id').all() as { id: string }[]).map(x => x.id), ['other-job', 'real-play'], 'another tenant\'s check and a real play survive')
})

// Hermes review at 989445c9, finding 2: a check whose process restarted mid-crawl stays 'running' with no claim.
test('#1036 a check job left running by a restart is reaped: not an active scan, removable; a fresh running one still refuses', async () => {
  const { reapStaleJobs, countActiveJobs } = await import('../lib/scan/store.ts')
  const db = setup(); const ins = db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, created_at) VALUES (?, ?, 'dazl real-company Find work email check (staging test)', 'staging check', 'staging check', 'running', ?)")
  ins.run('stale', T, now() - 3 * 86400)
  assert.equal(countActiveJobs(db, T), 1, 'precondition: it counts as active until reaped')
  reapStaleJobs(db)
  assert.deepEqual(db.prepare("SELECT status, error FROM scan_jobs WHERE id = 'stale'").get(), { status: 'failed', error: 'staging_check_interrupted' })
  assert.equal(countActiveJobs(db, T), 0, 'play-now / watches / monitors no longer see an active scan')
  ins.run('stale2', T, now() - 600)
  assert.deepEqual(deleteRealCompanyChecks(db, T), { deleted: 2 }, 'remove reaps and removes a dead check by itself')
  ins.run('fresh', T, now() - 30)
  assert.throws(() => deleteRealCompanyChecks(db, T), (e: unknown) => e instanceof FixtureError && e.code === 'check_in_flight', 'a crawl inside its deadline still refuses')
  reapStaleJobs(db); assert.equal((db.prepare("SELECT status FROM scan_jobs WHERE id = 'fresh'").get() as { status: string }).status, 'running', 'and is not reaped')
})
