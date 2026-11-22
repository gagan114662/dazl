// #1036 / #1250 Find work email: the buyer's work email is only an address the company prints on its own website, filed under that person
// (#383 buyer-role target, #899 published tier). No Apollo, People Data Labs, mailbox check or learned-format guess runs on any scan.
// Synthetic SQLite, invented company and people, fetch tracked: no network, no credits, no sign-in.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { createJob } from '../lib/scan/store.ts'
import { saveCredential, setEnrichFallback, enrichmentsForLeads } from '../lib/connectors/store.ts'
import { findWorkEmail, workEmailPageRead, PUBLISHED_ONLY_WORK_EMAIL_PROVIDERS } from '../lib/people/work-email.ts'
import { workEmailTargets, targetKey, workEmailCopy, queryName, siteSettled, sameRole, linkedinHandle, mergeLookups, TARGET_KEY_MAX, type ShownLookup } from '../lib/people/work-email-eligible.ts'
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
const HOME = '1 Main St, New York, NY 10001'
// every old input a provider path read: both keys, the paid fallback opt-in, guessing and a mailbox verifier
const OLD_ENV = { EMAIL_GUESS_ENABLED: '1', EMAIL_VERIFY_DAILY_CAP: '5', EMAIL_VERIFY_MONTHLY_CAP: '100', ZEROBOUNCE_API_KEY: 'synthetic-zerobounce-key' }

type Opts = { icp?: object; site?: boolean; tenant?: string }
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
  saveCredential(db, tenant, 'enrich:apollo', 'test-apollo-key-1234', master)
  saveCredential(db, tenant, 'enrich:pdl', 'test-pdl-key-5678', master)
  setEnrichFallback(db, tenant, true)
  return { db, lead, job, tenant }
}

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
const track = (urls: string[]) => (async (u: RequestInfo | URL) => { urls.push(String(u)); throw new Error('no network call is allowed') }) as typeof fetch
const run = (s: ReturnType<typeof seed>, target: unknown, f: typeof fetch, extra: { tenant?: string } = {}) =>
  findWorkEmail(s.db, extra.tenant ?? s.tenant, s.lead, target, { fetchImpl: f, master, now: NOW, env: OLD_ENV })
const publish = (s: ReturnType<typeof seed>, person: string, address: string, url = `https://${SITE}/team`) =>
  recordEmailGuesses(s.db, 'A', s.lead, SITE, [], [person], { env: OLD_ENV, homeText: HOME, seen: [{ address, url }] })

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

test('sameRole / linkedinHandle: role words and short forms; malformed values never match', () => {
  for (const [a, b] of [['Owner', 'Owner & Dentist'], ['CEO', 'Chief Executive Officer'], ['Co-Founder', 'Founder and CEO'], ['VP Sales', 'Vice President of Sales'], ['Practice Manager', 'practice manager']]) assert.equal(sameRole(a, b), true, `${a} ~ ${b}`)
  for (const [a, b] of [['Owner', 'Director'], ['Practice Manager', 'Office Manager'], ['Head of Sales', 'VP Sales'], ['Owner', ''], ['', ''], ['of the', 'and']]) assert.equal(sameRole(a, b), false, `${a} !~ ${b}`)
  for (const bad of [null, undefined, 42, {}, ['Owner']]) assert.equal(sameRole('Owner', bad as never), false)
  assert.equal(linkedinHandle('linkedin.com/in/Dana-Lee/?trk=x'), 'dana-lee')
  assert.equal(linkedinHandle('https://uk.linkedin.com/in/dana%2Dlee'), 'dana-lee')
  for (const bad of [null, 42, {}, 'https://notlinkedin.com/in/x', 'https://www.linkedin.com/company/x', 'linkedin.com/in/']) assert.equal(linkedinHandle(bad as never), null, String(bad))
  assert.equal(typeof linkedinHandle('https://www.linkedin.com/in/%E0%A4%A'), 'string', 'a broken escape is kept as typed, never thrown')
})

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
  // Greptile round 2: a retry that succeeds in the same second as the failure it replaces is shown, not hidden.
  const failed = { [DANA]: row(DANA, 'error', 100) }
  assert.equal(mergeLookups(failed, [row(DANA, 'verified', 100, 'x@harbordental.example')])[DANA].status, 'verified')
  assert.equal(mergeLookups({ [DANA]: row(DANA, 'uncertain', 100) }, [row(DANA, 'not_found', 100)])[DANA].status, 'not_found')
  assert.equal(mergeLookups(failed, [row(DANA, 'pending', 100)]), failed, 'a pending read never hides the failure it has not finished')
  assert.equal(mergeLookups(done, [row(DANA, 'error', 100)]), done, 'equal time: an open row never replaces a finished one')
  // The page's own click answer always replaces its person's row (even with an older or equal clock).
  assert.equal(mergeLookups(failed, [row(DANA, 'verified', 90, 'x@harbordental.example')], true)[DANA].status, 'verified')
  // Greptile round 3: a delayed failed POST from this tab never hides a success another tab's retry already showed.
  const shownOk = { [DANA]: row(DANA, 'verified', 120, 'x@harbordental.example') }
  for (const st of ['error', 'uncertain', 'pending']) {
    assert.equal(mergeLookups(shownOk, [row(DANA, st, 100)], true), shownOk, `own older ${st} keeps the shown success`)
    assert.equal(mergeLookups(shownOk, [row(DANA, st, 120)], true), shownOk, `own equal-time ${st} keeps the shown success`)
  }
  assert.equal(mergeLookups(shownOk, [row(DANA, 'error', 130)], true)[DANA].status, 'error', 'a strictly newer own row still wins')
  assert.equal(mergeLookups(shownOk, [row(DANA, 'not_found', 100)], true)[DANA].status, 'not_found', 'own finished answer still replaces')
  for (const junk of [null, 'x', 42, {}, [null, 7, 'x', { target: 1, status: 'verified' }, { target: DANA }, { status: 'verified' }]]) assert.equal(mergeLookups(done, junk), done, JSON.stringify(junk))
})

test('deleting a commenter batch deletes the work-email lookups of its leads (tenant-scoped)', () => {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  const r = importCommenters(db, 'A', parseImport('https://www.linkedin.com/in/jane-doe').valid, 'ctx')
  const leadId = (db.prepare('SELECT id FROM leads WHERE scan_job_id = ?').get(r.jobId) as { id: string }).id
  const ins = db.prepare("INSERT INTO work_email_lookups (tenant_id, lead_id, target, status, provider, address, updated_at) VALUES (?, ?, 'Jane Doe|CTO', 'unverified', 'pdl', 'jane@acme.example', 1)")
  ins.run('A', leadId); ins.run('B', 'other-tenant-lead')
  assert.equal(deleteCommenterBatch(db, 'B', r.batchId), false)
  assert.equal(deleteCommenterBatch(db, 'A', r.batchId), true)
  assert.deepEqual(db.prepare('SELECT tenant_id FROM work_email_lookups').all(), [{ tenant_id: 'B' }], "only the deleted lead's row went")
  // #1036 review: the addresses the crawl recorded (published tier, now recorded in prod) go with the leads too.
  const cand = db.prepare("INSERT INTO email_candidates (tenant_id, lead_id, person, address, format, country_basis, tier, source_url) VALUES (?, ?, 'Jane Doe, CTO', 'jane@acme.example', 'published', NULL, 'published', 'https://acme.example/team')")
  const r2 = importCommenters(db, 'A', parseImport('https://www.linkedin.com/in/jane-doe').valid, 'ctx')
  const lead2 = (db.prepare('SELECT id FROM leads WHERE scan_job_id = ?').get(r2.jobId) as { id: string }).id
  cand.run('A', lead2); cand.run('B', 'other-tenant-lead')
  db.prepare("INSERT INTO email_patterns (tenant_id, lead_id, site, format, support, confidence, score, runner_up, evidence) VALUES ('A', ?, 'acme.example', 'first', 2, 'high', 1, 0, '[]')").run(lead2)
  assert.equal(deleteCommenterBatch(db, 'A', r2.batchId), true)
  assert.deepEqual(db.prepare('SELECT tenant_id FROM email_candidates').all(), [{ tenant_id: 'B' }], "only the deleted lead's address went")
  assert.equal((db.prepare('SELECT count(*) AS n FROM email_patterns').get() as { n: number }).n, 0)
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
  await db.run("INSERT INTO email_candidates (tenant_id, lead_id, person, address, format, country_basis, tier, source_url) VALUES ('A', ?, 'Jane Doe, CEO', 'jane@acme.io', 'published', NULL, 'published', 'https://acme.io/team')", [lead.id])
  await db.run("INSERT INTO email_candidates (tenant_id, lead_id, person, address, format, country_basis, tier, source_url) VALUES ('B', 'b-lead', 'Jane Doe, CEO', 'jane@acme.io', 'published', NULL, 'published', 'https://acme.io/team')")
  assert.equal(await eraseFirstParty(db, 'A'), 1)
  assert.equal((await db.all("SELECT 1 FROM work_email_lookups WHERE tenant_id = 'A'")).length, 0)
  assert.equal((await db.all("SELECT 1 FROM work_email_lookups WHERE tenant_id = 'B'")).length, 1)
  assert.equal((await db.all("SELECT 1 FROM email_candidates WHERE tenant_id = 'A'")).length, 0, '#1036 review: the recorded address goes with its lead')
  assert.equal((await db.all("SELECT 1 FROM email_candidates WHERE tenant_id = 'B'")).length, 1)
})

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

test('a published address for the person is used first: free, no provider call, labelled published with its page', async () => {
  const s = seed(); const calls: string[] = []
  const env = { EMAIL_GUESS_ENABLED: '1' }
  recordEmailGuesses(s.db, 'A', s.lead, SITE, [], ['Dana Lee, Practice Manager'], { env, homeText: '1 Main St, New York, NY 10001', seen: [{ address: 'dana.lee@harbordental.example', url: `https://${SITE}/team` }] })
  const r = await run(s, DANA, track(calls))
  assert.equal(r.status, 'published'); assert.ok('row' in r)
  assert.deepEqual([r.row.address, r.row.source_url, r.row.provider], ['dana.lee@harbordental.example', `https://${SITE}/team`, 'site'])
  assert.equal(calls.length, 0)
  assert.deepEqual(workEmailCopy(r.row), { headline: 'Work email', note: 'Printed on the company website.', showAddress: true })
})

test('unchanged: the scan-time people search still never reads an email (the original drop rule stands for scans)', async () => {
  const people = await apolloPeopleSearch('k', { domain: SITE, name: 'Harbor Dental' }, (async () => json({ people: [{ name: 'Dana Lee', title: 'Practice Manager', email: 'dana.lee@harbordental.example', email_status: 'verified' }] })) as typeof fetch)
  assert.equal(JSON.stringify(people).includes('@'), false)
})

// ---- published only: no provider, no mailbox check, no guess (#1036 / #1250) ----
test('with both provider keys, the paid fallback, guessing and a verifier configured: no call, not_found, nothing stored', async () => {
  const s = seed(); const calls: string[] = []
  const r = await run(s, DANA, track(calls))
  assert.ok('row' in r)
  assert.deepEqual([r.status, r.row.address, r.row.provider, r.row.checked_at], ['not_found', null, null, null])
  assert.match(r.row.detail ?? '', /printed on the company website/)
  assert.equal(calls.length, 0, 'no Apollo, People Data Labs or mailbox call')
  assert.equal(s.db.prepare('SELECT count(*) FROM work_email_lookups').pluck().get(), 0, 'nothing is stored')
  assert.equal(s.db.prepare('SELECT count(*) FROM email_candidates').pluck().get(), 0)
  const page = workEmailPageRead(s.db, 'A', [{ id: s.lead }])
  assert.deepEqual(page.providers, PUBLISHED_ONLY_WORK_EMAIL_PROVIDERS)
  assert.deepEqual([page.lookups[s.lead], page.guesses[s.lead]], [[], undefined])
})

test('a stored provider answer or a mailbox-checked guess from the old flows is never shown or returned', async () => {
  const s = seed(); const calls: string[] = []
  s.db.prepare("INSERT INTO work_email_lookups (tenant_id, lead_id, target, status, provider, address, checked_at, updated_at) VALUES ('A', ?, ?, 'verified', 'apollo', ?, ?, ?)").run(s.lead, DANA, `dlee@${SITE}`, NOW, NOW)
  s.db.prepare("INSERT INTO email_candidates (tenant_id, lead_id, person, address, format, country_basis, tier, confidence, verification, verifier, checked_at) VALUES ('A', ?, 'Owen Park, Owner', ?, 'first.last', 'x', 'guessed', 'high', 'verified', 'zerobounce', ?)").run(s.lead, `owen.park@${SITE}`, NOW)
  for (const t of [DANA, OWEN]) {
    const r = await run(s, t, track(calls)); assert.ok('row' in r)
    assert.deepEqual([r.status, r.row.address], ['not_found', null], t)
  }
  assert.deepEqual(workEmailPageRead(s.db, 'A', [{ id: s.lead }]).lookups[s.lead], [])
  assert.equal(calls.length, 0)
})

test('recording the crawl never writes a guessed candidate or a learned format, with guessing switched on', () => {
  const s = seed()
  // two people print first.last addresses: the old pattern step would have guessed Dana's from them
  const r = recordEmailGuesses(s.db, 'A', s.lead, SITE, ['owen.park', 'zed.quinn'], ['Owen Park, Owner', 'Zed Quinn, Dentist', 'Dana Lee, Practice Manager'],
    { env: OLD_ENV, homeText: HOME, seen: [{ address: `owen.park@${SITE}`, url: `https://${SITE}/team` }, { address: `zed.quinn@${SITE}`, url: `https://${SITE}/team` }] })
  assert.equal(r?.published, 2); assert.equal(r?.candidates, 0)
  assert.deepEqual(s.db.prepare('SELECT DISTINCT tier FROM email_candidates').pluck().all(), ['published'])
  assert.equal(s.db.prepare("SELECT count(*) FROM email_candidates WHERE person LIKE 'Dana%'").pluck().get(), 0)
  assert.equal(s.db.prepare('SELECT count(*) FROM email_patterns').pluck().get(), 0)
})

test('two published addresses for one person offer neither; an off-site page is not first-party evidence', async () => {
  const s = seed()
  const ins = s.db.prepare("INSERT INTO email_candidates (tenant_id, lead_id, person, address, format, country_basis, tier, source_url) VALUES ('A', ?, 'Dana Lee, Practice Manager', ?, 'published', 'x', 'published', ?)")
  ins.run(s.lead, `dana.lee@${SITE}`, `https://${SITE}.other.example/bio`)
  assert.equal((await run(s, DANA, track([]))).status, 'not_found', 'printed on another site')
  s.db.prepare('DELETE FROM email_candidates').run()
  ins.run(s.lead, `dana@${SITE}`, `https://${SITE}/a`); ins.run(s.lead, `dlee@${SITE}`, `https://${SITE}/b`)
  assert.equal((await run(s, DANA, track([]))).status, 'not_found', 'which printed address is hers is not settled')
})

// ---- who may ask (tenant, lead state, target shape) ----
test('another tenant, a rejected lead, an unsettled site and malformed targets are refused', async () => {
  const s = seed(); const calls: string[] = []; const f = track(calls)
  assert.equal((await run(s, DANA, f, { tenant: 'B' })).status, 'lead_not_found')
  for (const t of [42, null, ['Dana Lee|Practice Manager'], { target: DANA }, '', 'x'.repeat(201), 'Fay Former|Former Practice Manager', 'Ann Aide|Assistant to the Owner', 'Sam Officer|Owner', 'Madonna|Owner', 'Hal Hygienist|Dental Hygienist', 'Dana Lee|Practice Manager\u0000', 'Dana Lee|CEO'])
    assert.equal((await run(s, t, f)).status, 'not_eligible', JSON.stringify(t))
  s.db.prepare('UPDATE leads SET quarantined_at = 1 WHERE id = ?').run(s.lead)
  assert.equal((await run(s, DANA, f)).status, 'not_eligible')
  const u = seed({ site: false })
  assert.equal((await run(u, DANA, f)).status, 'site_unsettled')
  assert.equal(calls.length, 0)
})

test('a corrupt saved play (icp not JSON) never throws: no buyer roles, so only decision-maker titles qualify', async () => {
  const s = seed(); s.db.prepare("UPDATE scan_jobs SET icp = '{not json' WHERE id = ?").run(s.job)
  publish(s, 'Owen Park, Owner', `owen.park@${SITE}`)
  assert.equal((await run(s, DANA, track([]))).status, 'not_eligible')
  assert.equal((await run(s, OWEN, track([]))).status, 'published')
})

test('boundary (#899): a published work email grants no send authority - drafts still need a published contact', async () => {
  const s = seed()
  s.db.prepare('UPDATE leads SET human_confirmed_at = 1 WHERE id = ?').run(s.lead)
  publish(s, 'Dana Lee, Practice Manager', `dana.lee@${SITE}`)
  assert.equal((await run(s, DANA, track([]))).status, 'published')
  assert.equal(draftBlockReason(s.db, 'A', s.lead), 'no_email_contact')
  const enrichments = enrichmentsForLeads(s.db, 'A', [s.lead])[s.lead]
  assert.equal(publishedEmail({ contact: null, enrichments }), null)
  assert.equal(enrichments.some(e => /@/.test(e.value)), false, 'nothing was written into the lead contact rows')
})

