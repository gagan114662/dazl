// #1036 Find work email (with #382 Apollo -> PDL fallback, #383 buyer-role target, #899 free-first published tier).
// Synthetic SQLite, invented company and people, stubbed providers: no network, no credits, no sign-in.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { createJob } from '../lib/scan/store.ts'
import { saveCredential, setEnrichFallback, recentAudit, enrichmentsForLeads } from '../lib/connectors/store.ts'
import { setCreditLimit, creditUse } from '../lib/enrich/credit-pool.ts'
import { findWorkEmail, judgeMatch, workEmailsFor, workEmailProviders, PENDING_STALE_S } from '../lib/people/work-email.ts'
import { workEmailTargets, targetKey, workEmailCopy, workEmailCostNote, queryName, siteSettled, sameRole, linkedinHandle, mergeLookups, TARGET_KEY_MAX, PENDING_POLL_MS, PENDING_POLL_MAX, type ShownLookup } from '../lib/people/work-email-eligible.ts'
import { deleteCommenterBatch, importCommenters, parseImport } from '../lib/scan/commenter-import.ts'
import { eraseFirstParty, ingest, recordConfig, signBody } from '../lib/signals/first-party.ts'
import { bothEngines } from './helpers/engines.ts'
import { identityOf } from '../lib/scan/opportunity.ts'
import { recordEmailGuesses } from '../lib/people/email-pattern.ts'
import { apolloPeopleSearch } from '../lib/enrich/apollo.ts'
import { draftBlockReason } from '../lib/outreach/service.ts'
import { publishedEmail } from '../lib/outreach/published-email.ts'

const master = randomBytes(32)
const NOW = 1_800_000_000
const SITE = 'harbordental.example'
const DANA = 'Dana Lee|Practice Manager', OWEN = 'Owen Park|Owner'
const ICP = { summary: 'NYC dental', where: ['New York, NY'], who: ['Practice manager', 'Owner'], signals: [] }

type Opts = { keys?: 'both' | 'apollo' | 'pdl' | 'none' | 'pdl-no-optin'; icp?: object; site?: boolean; tenant?: string }
function seed(o: Opts = {}) {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  const tenant = o.tenant ?? 'A'
  const job = createJob(db, tenant, { business_name: 'Seller', industry: 'software', location: 'New York' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify(o.icp ?? ICP), job)
  const lead = randomBytes(12).toString('hex')
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url, confidence) VALUES (?, ?, '', 'Harbor Dental', ?, 'hiring', 'https://harbordental.example/careers', 80)").run(lead, job, SITE)
  const add = (connector: string, kind: string, value: string, source_url: string, label: string | null = null) =>
    db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES (?, ?, ?, ?, ?, ?, ?, 70, ?, '2026-11-01', ?)").run(randomBytes(12).toString('hex'), lead, tenant, connector, kind, value, label, source_url, NOW - 100)
  if (o.site !== false) add('sitecrawl', 'domain', `${SITE}|evidence_own_domain`, `https://${SITE}/`, 'domain-basis-v1:evidence_own_domain')
  add('enrich:apollo', 'contact', 'Dana Lee - Practice Manager', 'https://www.linkedin.com/in/dana-lee-invented')
  add('sitecrawl', 'person', 'Owen Park, Owner', `https://${SITE}/team`)
  add('enrich:apollo', 'contact', 'Fay Former - Former Practice Manager', 'https://www.linkedin.com/in/fay')
  add('enrich:apollo', 'contact', 'Ann Aide - Assistant to the Owner', 'https://www.linkedin.com/in/ann')
  add('signals:sec-form-d', 'person', 'Sam Officer, Owner', 'https://www.sec.gov/x')
  add('enrich:pdl', 'contact', 'Madonna - Owner', 'https://www.linkedin.com/in/madonna')
  add('enrich:pdl', 'contact', 'Hal Hygienist - Dental Hygienist', 'https://www.linkedin.com/in/hal')
  const keys = o.keys ?? 'both'
  if (keys === 'both' || keys === 'apollo' || keys === 'pdl-no-optin') saveCredential(db, tenant, 'enrich:apollo', 'test-apollo-key-1234', master)
  if (keys === 'both' || keys === 'pdl' || keys === 'pdl-no-optin') saveCredential(db, tenant, 'enrich:pdl', 'test-pdl-key-5678', master)
  if (keys === 'both') setEnrichFallback(db, tenant, true)
  return { db, lead, job, tenant }
}

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
type Calls = { apollo: number; pdl: number; urls: string[] }
const stub = (apollo: () => Promise<Response> | Response, pdl: () => Promise<Response> | Response, calls: Calls = { apollo: 0, pdl: 0, urls: [] }) =>
  (async (u: RequestInfo | URL) => { const s = String(u); calls.urls.push(s); if (s.includes('apollo.io')) { calls.apollo++; return apollo() } calls.pdl++; return pdl() }) as typeof fetch
const apolloPerson = (over: Record<string, unknown> = {}) => json({ person: { name: 'Dana Lee', first_name: 'Dana', last_name: 'Lee', title: 'Practice Manager', email: 'dana.lee@harbordental.example', email_status: 'verified', country: 'United States', linkedin_url: 'https://www.linkedin.com/in/dana-lee-invented', organization: { name: 'Harbor Dental', primary_domain: SITE }, ...over } })
const pdlPerson = (over: Record<string, unknown> = {}) => json({ status: 200, likelihood: 8, data: { full_name: 'dana lee', job_title: 'practice manager', work_email: 'dlee@harbordental.example', location_country: 'united states', job_company_website: SITE, linkedin_url: 'linkedin.com/in/dana-lee-invented', ...over } })
const run = (s: ReturnType<typeof seed>, target: unknown, f: typeof fetch, extra: { now?: number; tenant?: string; env?: Record<string, string | undefined> } = {}) =>
  findWorkEmail(s.db, extra.tenant ?? s.tenant, s.lead, target, { fetchImpl: f, master, now: extra.now ?? NOW, env: extra.env ?? {} })
const never = () => { throw new Error('provider must not be called') }

// ---- who gets the button (#383 buyer-role target) ----
test('targets: only current buyer-role people with a first and last name on a settled site', () => {
  const s = seed()
  const rows = enrichmentsForLeads(s.db, 'A', [s.lead])[s.lead]
  const site = identityOf({ id: s.lead, contact: null }, rows)
  assert.ok(siteSettled(site))
  const keys = workEmailTargets(rows, ICP.who.join('; '), NOW * 1000, site).map(targetKey).sort()
  assert.deepEqual(keys, [DANA, OWEN], 'former, assistant-to, SEC-historical, single-name and non-buyer titles are not targets')
  // With no buyer roles entered, a decision-maker title still qualifies and a practice manager does not.
  assert.deepEqual(workEmailTargets(rows, '', NOW * 1000, site).map(targetKey), [OWEN])
  assert.equal(queryName('Madonna'), null); assert.deepEqual(queryName('Dr. Ana María López'), { first: 'Ana', last: 'López' })
})

// ---- the happy path and the waterfall (#382) ----
test('Apollo verified: one paid call, checked work email stored with provider and date; PDL not called; replay is free', async () => {
  const s = seed(); const calls: Calls = { apollo: 0, pdl: 0, urls: [] }
  const r = await run(s, DANA, stub(() => apolloPerson(), never, calls))
  assert.equal(r.status, 'verified')
  assert.ok('row' in r)
  assert.equal(r.row.address, 'dana.lee@harbordental.example'); assert.equal(r.row.provider, 'apollo'); assert.equal(r.row.checked_at, NOW)
  assert.deepEqual([calls.apollo, calls.pdl], [1, 0])
  const v = workEmailCopy(r.row); assert.equal(v.checked, true); assert.match(v.note, /Verified by Apollo on 2027-01-15/)
  // The Settings > Enrichment counter moved by exactly one Apollo credit.
  const use = (await creditUse(s.db, 'A', { now: NOW })).filter(u => u.provider === 'apollo' && u.window === 'day')
  assert.equal(use[0].reserved, 1)
  const again = await run(s, DANA, stub(never, never, calls))
  assert.equal(again.status, 'verified'); assert.ok('replayed' in again && again.replayed)
  assert.deepEqual([calls.apollo, calls.pdl], [1, 0], 'a finished lookup is never paid for again')
  assert.ok((recentAudit(s.db, 'A', 10) as { connector: string; status: string }[]).some(a => a.connector === 'workemail:apollo' && a.status === 'verified'))
  assert.equal(workEmailsFor(s.db, 'A', s.lead, NOW).length, 1)
})

for (const [why, apollo] of [
  ['no match', () => json({ person: null })],
  ['a guessed address only', () => apolloPerson({ email_status: 'guessed' })],
  ['401', () => new Response('no', { status: 401 })],
  ['429', () => new Response('slow', { status: 429 })],
  ['timeout', () => { throw new DOMException('aborted', 'AbortError') }],
  ['503', () => new Response('x', { status: 503 })],
] as [string, () => Response][]) {
  test(`Apollo ${why} -> PDL fallback is tried; its address is kept but NOT shown as checked`, async () => {
    const s = seed(); const calls: Calls = { apollo: 0, pdl: 0, urls: [] }
    const r = await run(s, DANA, stub(apollo, () => pdlPerson(), calls))
    assert.equal(r.status, 'unverified'); assert.ok('row' in r)
    assert.equal(r.row.address, 'dlee@harbordental.example'); assert.equal(r.row.provider, 'pdl'); assert.equal(r.row.checked_at, null)
    assert.deepEqual([calls.apollo, calls.pdl], [1, 1])
    const v = workEmailCopy(r.row); assert.equal(v.checked, false); assert.equal(v.headline, 'Found, not checked')
    if (why === 'a guessed address only') assert.doesNotMatch(JSON.stringify(workEmailsFor(s.db, 'A', s.lead, NOW)), /dana\.lee@/, "Apollo's guess is never stored")
  })
}

test('both providers fail: recorded as error with each reason; a retry claims again; credits of unknown calls stay counted', async () => {
  const s = seed(); const calls: Calls = { apollo: 0, pdl: 0, urls: [] }
  const r = await run(s, DANA, stub(() => new Response('', { status: 401 }), () => { throw new DOMException('t', 'TimeoutError') }, calls))
  assert.equal(r.status, 'error'); assert.ok('row' in r)
  assert.match(r.row.detail ?? '', /Apollo rejected your key; People Data Labs timed out/)
  const pdlUse = (await creditUse(s.db, 'A', { now: NOW })).find(u => u.provider === 'pdl' && u.window === 'day')
  assert.equal(pdlUse?.reserved, 1, 'a timed-out PDL call keeps its reserved credit (may have been billed)')
  const r2 = await run(s, DANA, stub(() => apolloPerson(), never, calls), { now: NOW + 5 })
  assert.equal(r2.status, 'verified', 'error is retryable')
})

test('PDL 404 is its unbilled no-match: not_found, and the PDL credit is released', async () => {
  const s = seed()
  const r = await run(s, DANA, stub(() => json({ person: null }), () => new Response('{}', { status: 404 })))
  assert.equal(r.status, 'not_found'); assert.ok('row' in r); assert.match(r.row.detail ?? '', /Apollo had no match; People Data Labs had no match/)
  const pdlUse = (await creditUse(s.db, 'A', { now: NOW })).find(u => u.provider === 'pdl' && u.window === 'day')
  assert.equal(pdlUse?.reserved ?? 0, 0)
})

test('PDL saved without the paid-fallback opt-in is never called, and the result says so', async () => {
  const s = seed({ keys: 'pdl-no-optin' }); const calls: Calls = { apollo: 0, pdl: 0, urls: [] }
  const r = await run(s, DANA, stub(() => json({ person: null }), never, calls))
  assert.equal(r.status, 'not_found'); assert.ok('row' in r); assert.match(r.row.detail ?? '', /fallback is off/)
  assert.equal(calls.pdl, 0)
  assert.deepEqual(workEmailProviders(s.db, 'A'), { apollo: true, pdl: false, pdlNeedsOptIn: true })
  assert.match(workEmailCostNote(workEmailProviders(s.db, 'A')), /People Data Labs fallback is off/)
})

test('PDL only (no Apollo key): PDL is the provider; no keys at all: no_key, nothing stored, nothing called', async () => {
  const p = seed({ keys: 'pdl' }); const calls: Calls = { apollo: 0, pdl: 0, urls: [] }
  assert.equal((await run(p, DANA, stub(never, () => pdlPerson(), calls))).status, 'unverified'); assert.deepEqual([calls.apollo, calls.pdl], [0, 1])
  const n = seed({ keys: 'none' })
  const r = await run(n, DANA, stub(never, never))
  assert.equal(r.status, 'no_key'); assert.equal(workEmailsFor(n.db, 'A', n.lead, NOW).length, 0)
  assert.match(workEmailCostNote(workEmailProviders(n.db, 'A')), /No Apollo or People Data Labs key set/)
})

// ---- identity, role and US gates: fail closed, address not kept ----
for (const [why, over, status, re] of [
  ['address on another domain', { email: 'dana@gmail.example' }, 'rejected', /not on harbordental\.example/],
  ['a different person', { name: 'Dan Leeson', first_name: 'Dan', last_name: 'Leeson' }, 'rejected', /different person/],
  ['a past role', { title: 'Former Practice Manager' }, 'rejected', /past or assistant role/],
  ['another company', { organization: { name: 'Other Dental', primary_domain: 'otherdental.example' } }, 'rejected', /another company/],
  ['a shared inbox', { email: 'info@harbordental.example' }, 'rejected', /shared inbox/],
  ['a bounced address', { email_status: 'bounced' }, 'rejected', /bounced/],
  ['a Canadian person', { country: 'Canada' }, 'not_us', /does not place them in the US \(Canada\)/],
  ['no country', { country: null }, 'not_us', /no country/],
  ['a non-string email', { email: 12345 }, 'not_found', /no work email/],
  ['an unreadable address', { email: 'not an address' }, 'not_found', /unreadable/],
] as [string, Record<string, unknown>, string, RegExp][]) {
  test(`Apollo returns ${why}: ${status}, no address kept or shown (no PDL key)`, async () => {
    const s = seed({ keys: 'apollo' })
    const r = await run(s, DANA, stub(() => apolloPerson(over), never))
    assert.equal(r.status, status); assert.ok('row' in r)
    assert.equal(r.row.address, null); assert.match(r.row.detail ?? '', re)
    assert.equal(workEmailCopy(r.row).showAddress, false)
  })
}

test("a play whose area names another country makes no paid call at all", async () => {
  const s = seed({ icp: { ...ICP, where: ['Toronto, Canada'] } }); const calls: Calls = { apollo: 0, pdl: 0, urls: [] }
  const r = await run(s, DANA, stub(never, never, calls))
  assert.equal(r.status, 'not_us'); assert.equal(calls.urls.length, 0)
})

// ---- who may ask (tenant, lead state, target shape) ----
test('another tenant, a rejected lead, an unsettled site and malformed targets are refused before any call', async () => {
  const s = seed(); const calls: Calls = { apollo: 0, pdl: 0, urls: [] }; const f = stub(never, never, calls)
  assert.equal((await run(s, DANA, f, { tenant: 'B' })).status, 'lead_not_found')
  for (const t of [42, null, ['Dana Lee|Practice Manager'], { target: DANA }, '', 'x'.repeat(201), 'Fay Former|Former Practice Manager', 'Ann Aide|Assistant to the Owner', 'Sam Officer|Owner', 'Madonna|Owner', 'Hal Hygienist|Dental Hygienist', 'Dana Lee|Practice Manager\u0000', 'Dana Lee|CEO'])
    assert.equal((await run(s, t, f)).status, 'not_eligible', JSON.stringify(t))
  s.db.prepare('UPDATE leads SET quarantined_at = 1 WHERE id = ?').run(s.lead)
  assert.equal((await run(s, DANA, f)).status, 'not_eligible')
  const u = seed({ site: false })
  assert.equal((await run(u, DANA, f)).status, 'site_unsettled')
  assert.equal(calls.urls.length, 0)
  assert.equal(workEmailsFor(s.db, 'A', s.lead, NOW).length, 0, 'refusals store nothing')
})

test('a corrupt saved play (icp not JSON) never throws: no buyer roles, so only decision-maker titles qualify', async () => {
  const s = seed(); s.db.prepare("UPDATE scan_jobs SET icp = '{not json' WHERE id = ?").run(s.job)
  assert.equal((await run(s, DANA, stub(never, never))).status, 'not_eligible')
  assert.equal((await run(s, OWEN, stub(() => apolloPerson({ name: 'Owen Park', first_name: 'Owen', last_name: 'Park', title: 'Owner', email: 'owen@harbordental.example' }), never))).status, 'verified')
})

// ---- money: durable claim before the call, caps, concurrency ----
test('double click: the second request while the first is in flight is busy and Apollo is called once', async () => {
  const s = seed(); const calls: Calls = { apollo: 0, pdl: 0, urls: [] }
  let release!: () => void; const gate = new Promise<void>(r => { release = r })
  const f = stub(async () => { await gate; return apolloPerson() }, never, calls)
  const first = run(s, DANA, f)
  await new Promise(r => setTimeout(r, 10))
  const second = await run(s, DANA, f)
  assert.equal(second.status, 'busy')
  release(); assert.equal((await first).status, 'verified')
  assert.equal(calls.apollo, 1)
})

test('a pending claim that never finished reads as uncertain after the stale window and may be retried', async () => {
  const s = seed()
  s.db.prepare("INSERT INTO work_email_lookups (tenant_id, lead_id, target, status, updated_at) VALUES ('A', ?, ?, 'pending', ?)").run(s.lead, DANA, NOW)
  assert.equal((await run(s, DANA, stub(never, never), { now: NOW + 10 })).status, 'busy')
  assert.equal(workEmailsFor(s.db, 'A', s.lead, NOW + PENDING_STALE_S + 1)[0].status, 'uncertain')
  assert.equal(workEmailCopy(workEmailsFor(s.db, 'A', s.lead, NOW + PENDING_STALE_S + 1)[0]).note, 'It may have used a credit on your key. You can try again.')
  assert.equal((await run(s, DANA, stub(() => apolloPerson(), never), { now: NOW + PENDING_STALE_S + 1 })).status, 'verified')
})

test('the workspace Apollo credit limit refuses the call (no request) and the lookup falls through to PDL', async () => {
  const s = seed(); const calls: Calls = { apollo: 0, pdl: 0, urls: [] }
  await setCreditLimit(s.db, 'A', 'apollo', 'day', 1)
  assert.equal((await run(s, DANA, stub(() => apolloPerson(), never, calls))).status, 'verified')
  const r = await run(s, OWEN, stub(never, () => pdlPerson({ full_name: 'Owen Park', job_title: 'Owner', work_email: 'owen@harbordental.example' }), calls))
  assert.equal(r.status, 'unverified'); assert.ok('row' in r); assert.match(r.row.detail ?? '', /Apollo credit limit reached/)
  assert.deepEqual([calls.apollo, calls.pdl], [1, 1])
  assert.ok((recentAudit(s.db, 'A', 10) as { status: string }[]).some(a => a.status === 'credit_cap'))
})

// ---- malformed provider answers ----
test('malformed provider bodies fail closed and are still recorded', async () => {
  for (const [apollo, pdl, want] of [
    [() => json({ person: ['not', 'an', 'object'] }), () => json({ data: [] }), 'not_found'],
    [() => json({ person: 'x' }), () => pdlPerson({ work_email: true }), 'not_found'], // PDL without contact access returns true, not an address
    [() => new Response('<html>', { status: 200 }), () => new Response('{', { status: 200 }), 'error'],
    [() => json(null), () => json({ data: { full_name: 42, work_email: ['a@b.c'] } }), 'rejected'],
  ] as [() => Response, () => Response, string][]) {
    const s = seed()
    const r = await run(s, DANA, stub(apollo, pdl))
    assert.equal(r.status, want, String(apollo))
    assert.ok('row' in r); assert.equal(r.row.address, null)
  }
})

const W = { first: 'Dana', last: 'Lee', title: 'Practice Manager', linkedin: null }
test('judgeMatch: every Apollo status other than verified is never "checked"', () => {
  const m = { name: 'Dana Lee', first: 'Dana', last: 'Lee', title: 'Practice Manager', email: 'dana.lee@harbordental.example', country: 'United States', orgDomain: SITE, linkedin: null }
  for (const st of ['unverified', 'likely to engage', null, 'pending_manual_fulfillment']) assert.equal(judgeMatch('apollo', { ...m, emailStatus: st }, W, SITE).kind, 'unverified', String(st))
  assert.equal(judgeMatch('apollo', { ...m, emailStatus: 'extrapolated' }, W, SITE).kind, 'guess')
  assert.equal(judgeMatch('apollo', { ...m, emailStatus: 'unavailable' }, W, SITE).kind, 'none')
  assert.equal(judgeMatch('pdl', { ...m }, W, SITE).kind, 'unverified', 'PDL never verifies')
  assert.equal(judgeMatch('apollo', { ...m, email: 'dana.lee@mail.harbordental.example', emailStatus: 'verified' }, W, SITE).kind, 'verified', 'a subdomain of the site is the same company')
  assert.equal(judgeMatch('apollo', { ...m, email: 'dana.lee@harbordental.example.evil', emailStatus: 'verified' }, W, SITE).kind, 'rejected')
})

// ---- review round 1 (XHawk + Greptile on #1049) ----
// XHawk #1 (High): two people with the same name at the same company must never get each other's address.
test('namesakes: a same-named person in another role or with another LinkedIn profile is refused, nothing kept', async () => {
  const m = { name: 'Dana Lee', first: 'Dana', last: 'Lee', title: 'Practice Manager', email: 'dana.lee@harbordental.example', emailStatus: 'verified', country: 'United States', orgDomain: SITE, linkedin: null as string | null }
  const withIn = { ...W, linkedin: 'https://www.linkedin.com/in/dana-lee-invented' }
  // LinkedIn known on both sides: the profile decides (role wording does not matter then).
  assert.equal(judgeMatch('apollo', { ...m, linkedin: 'https://linkedin.com/in/Dana-Lee-Invented/', title: 'Head of Practice' }, withIn, SITE).kind, 'verified')
  const other = judgeMatch('apollo', { ...m, linkedin: 'https://www.linkedin.com/in/dana-lee-2' }, withIn, SITE)
  assert.equal(other.kind, 'rejected'); assert.match((other as { note: string }).note, /different LinkedIn profile/)
  // Otherwise: same role AND the provider names the company.
  for (const [over, re] of [
    [{ title: 'Director of Operations' }, /different role \(Director of Operations\)/],
    [{ title: 'Office Manager' }, /different role/],
    [{ title: null }, /lists no role/],
    [{ orgDomain: null }, /does not name their company/],
  ] as [Record<string, unknown>, RegExp][]) {
    const v = judgeMatch('apollo', { ...m, ...over } as typeof m, W, SITE)
    assert.equal(v.kind, 'rejected', JSON.stringify(over)); assert.match((v as { note: string }).note, re)
  }
  assert.equal(judgeMatch('apollo', { ...m, title: 'Sr. Practice Manager' }, W, SITE).kind, 'verified')
  // End to end: the stored Owner (company site, no profile) is clicked; Apollo answers with the Director of the same name.
  const s = seed({ keys: 'apollo' })
  const r = await run(s, OWEN, stub(() => apolloPerson({ name: 'Owen Park', first_name: 'Owen', last_name: 'Park', title: 'Director', email: 'owen.park@harbordental.example', linkedin_url: null }), never))
  assert.equal(r.status, 'rejected'); assert.ok('row' in r); assert.equal(r.row.address, null); assert.match(r.row.detail ?? '', /different role \(Director\)/)
  // Dana's stored profile is dana-lee-invented: Apollo's other Dana Lee (another profile) is refused even with a matching title.
  const s2 = seed({ keys: 'apollo' })
  const r2 = await run(s2, DANA, stub(() => apolloPerson({ linkedin_url: 'https://www.linkedin.com/in/dana-lee-other' }), never))
  assert.equal(r2.status, 'rejected'); assert.ok('row' in r2); assert.equal(r2.row.address, null)
})

test('sameRole / linkedinHandle: role words and short forms; malformed values never match', () => {
  for (const [a, b] of [['Owner', 'Owner & Dentist'], ['CEO', 'Chief Executive Officer'], ['Co-Founder', 'Founder and CEO'], ['VP Sales', 'Vice President of Sales'], ['Practice Manager', 'practice manager']]) assert.equal(sameRole(a, b), true, `${a} ~ ${b}`)
  for (const [a, b] of [['Owner', 'Director'], ['Practice Manager', 'Office Manager'], ['Head of Sales', 'VP Sales'], ['Owner', ''], ['', ''], ['of the', 'and']]) assert.equal(sameRole(a, b), false, `${a} !~ ${b}`)
  for (const bad of [null, undefined, 42, {}, ['Owner']]) assert.equal(sameRole('Owner', bad as never), false)
  assert.equal(linkedinHandle('linkedin.com/in/Dana-Lee/?trk=x'), 'dana-lee')
  assert.equal(linkedinHandle('https://uk.linkedin.com/in/dana%2Dlee'), 'dana-lee')
  for (const bad of [null, 42, {}, 'https://notlinkedin.com/in/x', 'https://www.linkedin.com/company/x', 'linkedin.com/in/']) assert.equal(linkedinHandle(bad as never), null, String(bad))
  assert.equal(typeof linkedinHandle('https://www.linkedin.com/in/%E0%A4%A'), 'string', 'a broken escape is kept as typed, never thrown')
})

// XHawk #2: the target key is never cut, so two people whose name|title share the first 200 characters cannot merge.
test('target keys are full, never truncated; an over-long key is not a target; same name+title with two profiles is no target', () => {
  const s = seed()
  const long = 'Director ' + 'x'.repeat(195) // name|title = 214 characters; the first 200 are the same for both
  const add = (connector: string, value: string, url: string) => s.db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES (?, ?, 'A', ?, 'contact', ?, NULL, 70, ?, '2026-11-01', ?)").run(randomBytes(12).toString('hex'), s.lead, connector, value, url, NOW - 100)
  add('enrich:apollo', `Pat Long - ${long}a`, 'https://www.linkedin.com/in/pat-a')
  add('enrich:apollo', `Pat Long - ${long}b`, 'https://www.linkedin.com/in/pat-b')
  add('enrich:apollo', 'Alex Smith - Owner', 'https://www.linkedin.com/in/alex-smith-1')
  add('enrich:pdl', 'Alex Smith - Owner', 'https://www.linkedin.com/in/alex-smith-2')
  add('enrich:apollo', 'Kim Ray - Owner', 'https://www.linkedin.com/in/kim-ray')
  add('enrich:pdl', 'Kim Ray - Owner', 'https://www.linkedin.com/in/Kim-Ray/')
  const rows = enrichmentsForLeads(s.db, 'A', [s.lead])[s.lead]
  const site = identityOf({ id: s.lead, contact: null }, rows)
  const keys = workEmailTargets(rows, '', NOW * 1000, site).map(targetKey)
  for (const k of keys) assert.ok(k.length <= TARGET_KEY_MAX, k)
  assert.ok(!keys.some(k => k.startsWith('Pat Long')), 'over-long name|title pairs are not offered (no cut key)')
  assert.ok(!keys.includes('Alex Smith|Owner'), 'two different profiles under one name+title are not offered')
  assert.equal(keys.filter(k => k === 'Kim Ray|Owner').length, 1, 'the same profile found twice is one target')
  assert.ok(keys.includes(OWEN))
  assert.notEqual(targetKey({ name: 'Pat Long', title: `${long}a` }), targetKey({ name: 'Pat Long', title: `${long}b` }))
})

// Greptile P1 #1: with both keys saved and the paid fallback OFF, an unreadable Apollo key never lets PDL spend.
test('fallback off + unreadable Apollo key: PDL is never called; the lookup is a retryable error', async () => {
  const s = seed({ keys: 'pdl-no-optin' }); const calls: Calls = { apollo: 0, pdl: 0, urls: [] }
  s.db.prepare("UPDATE tenant_connectors SET ciphertext = 'not-a-real-ciphertext' WHERE tenant_id = 'A' AND connector = 'enrich:apollo'").run()
  const r = await run(s, DANA, stub(never, never, calls))
  assert.equal(calls.urls.length, 0, 'no provider call, PDL included')
  assert.equal(r.status, 'error'); assert.ok('row' in r); assert.match(r.row.detail ?? '', /Apollo key could not be read/)
  assert.equal(((await creditUse(s.db, 'A', { now: NOW })).find(u => u.provider === 'pdl' && u.window === 'day')?.reserved ?? 0), 0)
  // Same with a wrong master key (every key unreadable).
  const s2 = seed({ keys: 'pdl-no-optin' }); const c2: Calls = { apollo: 0, pdl: 0, urls: [] }
  const r2 = await findWorkEmail(s2.db, 'A', s2.lead, DANA, { fetchImpl: stub(never, never, c2), master: randomBytes(32), now: NOW, env: {} })
  assert.equal(r2.status, 'error'); assert.equal(c2.urls.length, 0)
})

// Greptile P1 #2: a provider that should have answered and did not leaves the lookup retryable, never a final not_found.
for (const [why, pdl, setup] of [
  ['PDL times out', () => { throw new DOMException('t', 'TimeoutError') }, null],
  ['PDL rejects its key', () => new Response('', { status: 401 }), null],
  ['PDL hits the workspace credit limit', never, 'pdl-cap'],
  ['PDL key unreadable', never, 'pdl-bad-key'],
] as [string, () => Response, string | null][]) {
  test(`Apollo no match, then ${why}: retryable error (not a final not_found); a later retry runs again`, async () => {
    const s = seed()
    if (setup === 'pdl-cap') { // the one PDL credit allowed today goes on Owen first
      await setCreditLimit(s.db, 'A', 'pdl', 'day', 1)
      assert.equal((await run(s, OWEN, stub(() => json({ person: null }), () => pdlPerson({ full_name: 'Owen Park', job_title: 'Owner', work_email: 'owen@harbordental.example' })))).status, 'unverified')
    }
    if (setup === 'pdl-bad-key') s.db.prepare("UPDATE tenant_connectors SET ciphertext = 'garbage' WHERE tenant_id = 'A' AND connector = 'enrich:pdl'").run()
    const r = await run(s, DANA, stub(() => json({ person: null }), pdl))
    assert.equal(r.status, 'error', why); assert.ok('row' in r); assert.equal(r.row.address, null)
    assert.match(r.row.detail ?? '', /Apollo had no match/)
    assert.equal(workEmailCopy(r.row).headline, 'Lookup failed')
    const again = await run(s, DANA, stub(() => apolloPerson(), never), { now: NOW + 5 })
    assert.equal(again.status, 'verified'); assert.ok('replayed' in again && !again.replayed)
  })
}
test('Apollo refuses a namesake and PDL fails: still retryable (incomplete), not a final rejected', async () => {
  const s = seed()
  const r = await run(s, DANA, stub(() => apolloPerson({ title: 'Director', linkedin_url: null }), () => { throw new DOMException('t', 'TimeoutError') }))
  assert.equal(r.status, 'error')
})

// Greptile P2 (CHECKs): a NULL provider never satisfies a checked status.
test('the table refuses verified / published / unverified with a NULL provider', () => {
  const s = seed()
  const ins = (status: string, provider: string | null, checked: number | null, url: string | null) =>
    s.db.prepare('INSERT INTO work_email_lookups (tenant_id, lead_id, target, status, provider, address, checked_at, source_url, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)').run('A', s.lead, randomBytes(4).toString('hex'), status, provider, 'a@harbordental.example', checked, url)
  assert.throws(() => ins('verified', null, 1, null), /CHECK/)
  assert.throws(() => ins('published', null, null, 'https://harbordental.example/team'), /CHECK/)
  assert.throws(() => ins('unverified', null, null, null), /CHECK/)
  assert.throws(() => ins('unverified', 'site', null, null), /CHECK/)
  ins('published', 'site', null, 'https://harbordental.example/team'); ins('unverified', 'pdl', null, null)
})

// XHawk #3 / Greptile P2 x2 (page): merge rows by updated_at; a slow older read never erases a newer result; pending is followed.
test('mergeLookups: older or missing rows never erase a newer result; pending gives way to finished or uncertain', () => {
  const row = (target: string, status: string, updated_at: number, address: string | null = null): ShownLookup => ({ target, status, provider: null, address, detail: null, source_url: null, checked_at: null, updated_at })
  const done = { [DANA]: row(DANA, 'verified', 100, 'dana.lee@harbordental.example') }
  assert.equal(mergeLookups(done, []), done, 'an empty read (started before the click) keeps the shown result')
  assert.equal(mergeLookups(done, [row(DANA, 'pending', 99)]), done, 'an older pending read never replaces it')
  assert.equal(mergeLookups(done, [row(DANA, 'pending', 100)]), done, 'equal time: a finished row is never replaced by pending')
  const pend = { [DANA]: row(DANA, 'pending', 100) }
  assert.equal(mergeLookups(pend, [row(DANA, 'verified', 100, 'x@harbordental.example')])[DANA].status, 'verified')
  assert.equal(mergeLookups(pend, [row(DANA, 'uncertain', 100)])[DANA].status, 'uncertain', 'the stale window turns pending into retryable')
  assert.equal(mergeLookups(pend, [row(DANA, 'not_found', 140)])[DANA].status, 'not_found')
  assert.equal(mergeLookups({}, [row(OWEN, 'pending', 1)])[OWEN].status, 'pending')
  for (const junk of [null, 'x', 42, {}, [null, 7, 'x', { target: 1, status: 'verified' }, { target: DANA }, { status: 'verified' }]]) assert.equal(mergeLookups(done, junk), done, JSON.stringify(junk))
  assert.ok(PENDING_POLL_MS * PENDING_POLL_MAX > PENDING_STALE_S * 1000, 'the page keeps following a pending row past the server stale window')
})

// XHawk #4 (outside the diff): deleting a lead deletes its work-email rows (commenter batch delete, first-party erase).
test('deleting a commenter batch deletes the work-email lookups of its leads (tenant-scoped)', () => {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  const r = importCommenters(db, 'A', parseImport('https://www.linkedin.com/in/jane-doe').valid, 'ctx')
  const leadId = (db.prepare('SELECT id FROM leads WHERE scan_job_id = ?').get(r.jobId) as { id: string }).id
  const ins = db.prepare("INSERT INTO work_email_lookups (tenant_id, lead_id, target, status, provider, address, updated_at) VALUES (?, ?, 'Jane Doe|CTO', 'unverified', 'pdl', 'jane@acme.example', 1)")
  ins.run('A', leadId); ins.run('B', 'other-tenant-lead')
  assert.equal(deleteCommenterBatch(db, 'B', r.batchId), false)
  assert.equal(deleteCommenterBatch(db, 'A', r.batchId), true)
  assert.deepEqual(db.prepare('SELECT tenant_id FROM work_email_lookups').all(), [{ tenant_id: 'B' }], "only the deleted lead's row went")
})

bothEngines('first-party erase deletes the work-email lookups of the erased leads', async ({ db }) => {
  process.env.DAZL_MASTER_KEY ??= randomBytes(32).toString('base64')
  const T = 1_793_000_000
  await recordConfig(db, 'A', { site_domain: 'seller.test', basis: 'consent', privacy_url: 'https://seller.test/privacy', retention_days: 90 }, 'actor-a', T)
  const raw = JSON.stringify({ events: [{ id: 'v1', type: 'site_visit', occurred_at: new Date((T - 600) * 1000).toISOString(), page_url: 'https://seller.test/pricing', consent: 'granted', network: 'business', account: { domain: 'acme.io', basis: 'logged_in_account' } }] })
  await ingest(db, 'A', raw, signBody('s', T, raw), T)
  const lead = (await db.all<{ id: string }>("SELECT l.id FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE j.user_id = 'A' AND l.source_kind = 'first_party'"))[0]
  assert.ok(lead, 'the visit made a first-party lead')
  await db.run("INSERT INTO work_email_lookups (tenant_id, lead_id, target, status, provider, address, updated_at) VALUES ('A', ?, 'Jane Doe|CEO', 'unverified', 'pdl', 'jane@acme.io', 1)", [lead.id])
  await db.run("INSERT INTO work_email_lookups (tenant_id, lead_id, target, status, provider, address, updated_at) VALUES ('B', 'b-lead', 'Jane Doe|CEO', 'unverified', 'pdl', 'jane@acme.io', 1)")
  assert.equal(await eraseFirstParty(db, 'A'), 1)
  assert.equal((await db.all("SELECT 1 FROM work_email_lookups WHERE tenant_id = 'A'")).length, 0)
  assert.equal((await db.all("SELECT 1 FROM work_email_lookups WHERE tenant_id = 'B'")).length, 1)
})

// ---- storage invariants: the table itself refuses an unchecked "verified" ----
test('the table refuses verified without Apollo + check time, published without its page, and an address on a no-address status', () => {
  const s = seed()
  const ins = (status: string, provider: string | null, address: string | null, checked: number | null, url: string | null) =>
    s.db.prepare('INSERT INTO work_email_lookups (tenant_id, lead_id, target, status, provider, address, checked_at, source_url, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)').run('A', s.lead, randomBytes(4).toString('hex'), status, provider, address, checked, url)
  assert.throws(() => ins('verified', 'pdl', 'a@harbordental.example', 1, null), /CHECK/)
  assert.throws(() => ins('verified', 'apollo', 'a@harbordental.example', null, null), /CHECK/)
  assert.throws(() => ins('published', 'site', 'a@harbordental.example', null, null), /CHECK/)
  assert.throws(() => ins('not_found', null, 'a@harbordental.example', null, null), /CHECK/)
  assert.throws(() => ins('unverified', 'pdl', null, null, null), /CHECK/)
  assert.throws(() => ins('checked', null, null, null, null), /CHECK/)
  ins('verified', 'apollo', 'a@harbordental.example', 1, null)
})

// ---- free tier first (#899 published) and the outreach boundary ----
test('a published address for the person is used first: free, no provider call, labelled published with its page', async () => {
  const s = seed({ keys: 'none' }); const calls: Calls = { apollo: 0, pdl: 0, urls: [] }
  const env = { EMAIL_GUESS_ENABLED: '1' }
  recordEmailGuesses(s.db, 'A', s.lead, SITE, [], ['Dana Lee, Practice Manager'], { env, homeText: '1 Main St, New York, NY 10001', seen: [{ address: 'dana.lee@harbordental.example', url: `https://${SITE}/team` }] })
  const r = await run(s, DANA, stub(never, never, calls))
  assert.equal(r.status, 'published'); assert.ok('row' in r)
  assert.deepEqual([r.row.address, r.row.source_url, r.row.provider], ['dana.lee@harbordental.example', `https://${SITE}/team`, 'site'])
  assert.equal(calls.urls.length, 0)
  assert.equal(workEmailCopy(r.row).checked, true)
})

test('a guessed candidate is never the free tier, even marked verified; two published addresses for one person offer neither', async () => {
  const s = seed({ keys: 'none' })
  const env = { EMAIL_GUESS_ENABLED: '1' }
  // Owen's address is printed, so the pattern first.last is learned from two people; Dana gets a GUESSED candidate.
  recordEmailGuesses(s.db, 'A', s.lead, SITE, ['owen.park', 'zed.quinn'], ['Owen Park, Owner', 'Zed Quinn, Dentist', 'Dana Lee, Practice Manager'], { env, homeText: '1 Main St, New York, NY 10001', seen: [{ address: 'owen.park@harbordental.example', url: `https://${SITE}/team` }, { address: 'zed.quinn@harbordental.example', url: `https://${SITE}/team` }] })
  s.db.prepare("UPDATE email_candidates SET verification = 'verified', verifier = 'synthetic', checked_at = 1 WHERE tier = 'guessed'").run()
  assert.ok((s.db.prepare("SELECT count(*) n FROM email_candidates WHERE tier = 'guessed' AND person LIKE 'Dana%'").get() as { n: number }).n === 1)
  assert.equal((await run(s, DANA, stub(never, never))).status, 'no_key', 'the guessed row is not offered')
  assert.equal((await run(s, OWEN, stub(never, never))).status, 'published')
  s.db.prepare("INSERT INTO email_candidates (tenant_id, lead_id, person, address, format, country_basis, tier, source_url) VALUES ('A', ?, 'Dana Lee, Practice Manager', 'dana@harbordental.example', 'published', 'x', 'published', 'https://harbordental.example/a')").run(s.lead)
  s.db.prepare("INSERT INTO email_candidates (tenant_id, lead_id, person, address, format, country_basis, tier, source_url) VALUES ('A', ?, 'Dana Lee, Practice Manager', 'dlee@harbordental.example', 'published', 'x', 'published', 'https://harbordental.example/b')").run(s.lead)
  assert.equal((await run(s, DANA, stub(never, never))).status, 'no_key', 'which printed address is hers is not settled')
})

test('boundary (#899): a verified work email grants no send authority - drafts still need a published contact', async () => {
  const s = seed()
  s.db.prepare('UPDATE leads SET human_confirmed_at = 1 WHERE id = ?').run(s.lead)
  assert.equal((await run(s, DANA, stub(() => apolloPerson(), never))).status, 'verified')
  assert.equal(draftBlockReason(s.db, 'A', s.lead), 'no_email_contact')
  const enrichments = enrichmentsForLeads(s.db, 'A', [s.lead])[s.lead]
  assert.equal(publishedEmail({ contact: null, enrichments }), null)
  assert.equal(enrichments.some(e => /@/.test(e.value)), false, 'nothing was written into the lead contact rows')
})

test('unchanged: the scan-time people search still never reads an email (the original drop rule stands for scans)', async () => {
  const people = await apolloPeopleSearch('k', { domain: SITE, name: 'Harbor Dental' }, (async () => json({ people: [{ name: 'Dana Lee', title: 'Practice Manager', email: 'dana.lee@harbordental.example', email_status: 'verified' }] })) as typeof fetch)
  assert.equal(JSON.stringify(people).includes('@'), false)
})
