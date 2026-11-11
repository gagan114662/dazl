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
import { workEmailTargets, targetKey, workEmailCopy, workEmailCostNote, queryName, siteSettled } from '../lib/people/work-email-eligible.ts'
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

test('judgeMatch: every Apollo status other than verified is never "checked"', () => {
  const m = { name: 'Dana Lee', first: 'Dana', last: 'Lee', title: 'Practice Manager', email: 'dana.lee@harbordental.example', country: 'United States', orgDomain: SITE, linkedin: null }
  for (const st of ['unverified', 'likely to engage', null, 'pending_manual_fulfillment']) assert.equal(judgeMatch('apollo', { ...m, emailStatus: st }, { first: 'Dana', last: 'Lee' }, SITE).kind, 'unverified', String(st))
  assert.equal(judgeMatch('apollo', { ...m, emailStatus: 'extrapolated' }, { first: 'Dana', last: 'Lee' }, SITE).kind, 'guess')
  assert.equal(judgeMatch('apollo', { ...m, emailStatus: 'unavailable' }, { first: 'Dana', last: 'Lee' }, SITE).kind, 'none')
  assert.equal(judgeMatch('pdl', { ...m }, { first: 'Dana', last: 'Lee' }, SITE).kind, 'unverified', 'PDL never verifies')
  assert.equal(judgeMatch('apollo', { ...m, email: 'dana.lee@mail.harbordental.example', emailStatus: 'verified' }, { first: 'Dana', last: 'Lee' }, SITE).kind, 'verified', 'a subdomain of the site is the same company')
  assert.equal(judgeMatch('apollo', { ...m, email: 'dana.lee@harbordental.example.evil', emailStatus: 'verified' }, { first: 'Dana', last: 'Lee' }, SITE).kind, 'rejected')
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
