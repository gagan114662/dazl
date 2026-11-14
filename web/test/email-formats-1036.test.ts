// #1036: learned company email formats (per tenant, from addresses already confirmed), the honest guessed-address labels, and the
// mailbox-check counter. Synthetic SQLite, invented companies and people, no provider, no network, no key.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { createJob } from '../lib/scan/store.ts'
import { findWorkEmail, workEmailsFor } from '../lib/people/work-email.ts'
import { confirmedAddressesAt, guessesForLead, guessFor, guessFromLearnedFormat, learnedFormat, rankConfirmed } from '../lib/people/email-formats.ts'
import { reserveVerifySlot, VerifySlotRefused } from '../lib/people/email-pattern.ts'
import { mailboxCheckUsage } from '../lib/people/verify-usage.ts'
import { guessCopy, type GuessShown } from '../lib/people/work-email-eligible.ts'
import { PRIVACY } from '../lib/legal/policy.ts'

const NOW = 1_800_000_000
const SITE = 'harbordental.example'
const BASIS = 'homepage address: Austin, TX 78701'
const ON = { EMAIL_GUESS_ENABLED: '1' }
const ICP = { summary: 'dental', where: ['Austin, TX'], who: ['Practice manager', 'Owner'], signals: [] }
const n = (db: Database.Database, sql: string): number => (db.prepare(sql).get() as { n: number }).n

// A lead on a settled site with two buyer-role people (Dana Lee, Owen Park) and no key of any provider.
function seed(tenant = 'A') {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  const job = createJob(db, tenant, { business_name: 'Seller', industry: 'software', location: 'Austin' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify(ICP), job)
  const lead = randomBytes(12).toString('hex')
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url, confidence) VALUES (?, ?, '', 'Harbor Dental', ?, 'hiring', 'https://harbordental.example/careers', 80)").run(lead, job, SITE)
  const add = (connector: string, kind: string, value: string, source_url: string, label: string | null = null) =>
    db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES (?, ?, ?, ?, ?, ?, ?, 70, ?, '2026-11-01', ?)").run(randomBytes(12).toString('hex'), lead, tenant, connector, kind, value, label, source_url, NOW)
  add('sitecrawl', 'domain', `${SITE}|evidence_own_domain`, `https://${SITE}/`, 'domain-basis-v1:evidence_own_domain')
  add('sitecrawl', 'person', 'Dana Lee, Practice Manager', `https://${SITE}/team`)
  add('sitecrawl', 'person', 'Owen Park, Owner', `https://${SITE}/team`)
  return { db, lead, job, tenant }
}
// A published, confirmed address of this tenant on another of its leads at the same company (printed on the company's own page).
const published = (db: Database.Database, tenant: string, lead: string, person: string, address: string, url = `https://${SITE}/team`, basis: string | null = BASIS) =>
  db.prepare("INSERT INTO email_candidates (tenant_id, lead_id, person, address, format, country_basis, tier, source_url) VALUES (?, ?, ?, ?, 'published', ?, 'published', ?)").run(tenant, lead, person, address, basis, url)
const twoConfirmed = (db: Database.Database, tenant = 'A') => {
  published(db, tenant, 'other-lead', 'Pat Kim, Owner', `pat.kim@${SITE}`)
  published(db, tenant, 'other-lead', 'Sue Ray, Partner', `sue.ray@${SITE}`, `https://${SITE}/about`)
}
const DANA = 'Dana Lee|Practice Manager'

test('#1036 learned format: two confirmed addresses of different people teach a high-confidence format with their pages; one teaches a low one; the evidence is kept', () => {
  const s = seed(); twoConfirmed(s.db)
  const f = learnedFormat(s.db, 'A', SITE)!
  assert.deepEqual([f.format, f.support, f.confidence, f.basis], ['first.last', 2, 'high', BASIS])
  assert.deepEqual(f.evidence.map(e => [e.address, e.url]).sort(), [[`pat.kim@${SITE}`, `https://${SITE}/team`], [`sue.ray@${SITE}`, `https://${SITE}/about`]])
  s.db.prepare('DELETE FROM email_candidates WHERE address = ?').run(`sue.ray@${SITE}`)
  const one = learnedFormat(s.db, 'A', SITE)!
  assert.deepEqual([one.format, one.support, one.confidence], ['first.last', 1, 'low'])
  s.db.prepare('DELETE FROM email_candidates').run()
  assert.equal(learnedFormat(s.db, 'A', SITE), null, 'nothing confirmed: no format')
  assert.equal(n(s.db, "SELECT count(*) AS n FROM sqlite_master WHERE name = 'email_domain_formats'"), 0, 'nothing is stored on its own')
})

test('#1036 learned format: a lookup-confirmed address (published or Apollo-verified) counts too, but only a published row with a US basis can vouch for the country', () => {
  const s = seed()
  const lookup = (target: string, status: string, provider: string, address: string, url: string | null) => s.db.prepare("INSERT INTO work_email_lookups (tenant_id, lead_id, target, status, provider, address, source_url, checked_at, updated_at) VALUES ('A', 'x', ?, ?, ?, ?, ?, ?, ?)").run(target, status, provider, address, url, status === 'verified' ? NOW : null, NOW)
  lookup('Pat Kim|Owner', 'verified', 'apollo', `pat.kim@${SITE}`, null)
  lookup('Sue Ray|Partner', 'published', 'site', `sue.ray@${SITE}`, `https://${SITE}/team`)
  assert.equal(confirmedAddressesAt(s.db, 'A', SITE).length, 2)
  assert.equal(learnedFormat(s.db, 'A', SITE), null, 'no published row with a country basis: no US evidence, no format to guess from')
  published(s.db, 'A', 'x', 'Lou Fox, Owner', `lou.fox@${SITE}`)
  const f = learnedFormat(s.db, 'A', SITE)!
  assert.deepEqual([f.format, f.support, f.confidence, f.basis], ['first.last', 3, 'high', BASIS])
  assert.equal(rankConfirmed(SITE, confirmedAddressesAt(s.db, 'A', SITE))!.evidence.length, 3)
})

test("#1036 learned format: per tenant (another tenant's addresses teach nothing), exact domain only, role inboxes teach nothing, a one-name format needs two people", () => {
  const s = seed(); twoConfirmed(s.db, 'B') // tenant B's confirmed addresses
  assert.equal(learnedFormat(s.db, 'A', SITE), null, 'tenant A holds no confirmed address')
  assert.equal(learnedFormat(s.db, 'B', SITE)!.format, 'first.last')
  published(s.db, 'A', 'x', 'Pat Kim, Owner', `pat.kim@mail.${SITE}`); published(s.db, 'A', 'x', 'Sue Ray, Partner', `sue.ray@mail.${SITE}`)
  assert.equal(learnedFormat(s.db, 'A', SITE), null, "a subdomain's addresses do not teach the parent domain's format")
  assert.equal(learnedFormat(s.db, 'A', `mail.${SITE}`)!.format, 'first.last')
  const r = seed(); published(r.db, 'A', 'x', 'Nora Wall, Owner', `nora@${SITE}`)
  assert.equal(learnedFormat(r.db, 'A', SITE), null, "one person's first-name-only address says too little")
  published(r.db, 'A', 'x', 'Lou Fox, Partner', `lou@${SITE}`)
  assert.equal(learnedFormat(r.db, 'A', SITE)!.format, 'first', 'two people with the same one-name format: learned')
  const role = seed(); published(role.db, 'A', 'x', 'Info Desk, Owner', `info@${SITE}`)
  assert.equal(learnedFormat(role.db, 'A', SITE), null, "a shared inbox is no person's address")
})

test("#1036 find work email with nothing found: a learned-format guess comes back labelled guessed-unverified with what taught it; stored as a guessed candidate, never a lookup row; replays the same; a deleted confirmed address leaves no trace in what is shown", async () => {
  const s = seed(); twoConfirmed(s.db)
  const r = await findWorkEmail(s.db, 'A', s.lead, DANA, { env: ON, now: NOW })
  assert.equal(r.status, 'no_key')
  assert.ok(r.guess, 'a guess is offered')
  assert.deepEqual([r.guess!.address, r.guess!.label, r.guess!.state, r.guess!.format, r.guess!.confidence, r.guess!.verifier], [`dana.lee@${SITE}`, 'guessed, unverified', 'not_checked', 'first.last', 'high', null])
  assert.deepEqual(r.guess!.learned_from.map(e => e.address).sort(), [`pat.kim@${SITE}`, `sue.ray@${SITE}`])
  const row = s.db.prepare('SELECT tier, verification, confidence, country_basis, format, tenant_id, lead_id FROM email_candidates WHERE address = ?').get(`dana.lee@${SITE}`)
  assert.deepEqual(row, { tier: 'guessed', verification: 'none', confidence: 'high', country_basis: BASIS, format: 'first.last', tenant_id: 'A', lead_id: s.lead })
  assert.deepEqual(workEmailsFor(s.db, 'A', s.lead, NOW), [], 'a guess is not a work-email lookup')
  const again = await findWorkEmail(s.db, 'A', s.lead, DANA, { env: ON, now: NOW + 5 })
  assert.equal(again.guess?.address, `dana.lee@${SITE}`)
  assert.equal(n(s.db, "SELECT count(*) AS n FROM email_candidates WHERE tier = 'guessed'"), 1, 'one row, however often it is clicked')
  assert.deepEqual(guessesForLead(s.db, 'A', s.lead, ON).map(g => g.address), [`dana.lee@${SITE}`], 'the GET read after a reload')
  // what taught the format is always what the tenant still holds: delete one confirmed address and it is gone from the evidence
  s.db.prepare('DELETE FROM email_candidates WHERE address = ?').run(`pat.kim@${SITE}`)
  assert.deepEqual(guessesForLead(s.db, 'A', s.lead, ON)[0].learned_from.map(e => e.address), [`sue.ray@${SITE}`])
  published(s.db, 'A', 'other-lead', 'Pat Kim, Owner', `pat.kim@${SITE}`)
  // a second buyer of the same lead gets the same format
  const owen = await findWorkEmail(s.db, 'A', s.lead, 'Owen Park|Owner', { env: ON, now: NOW })
  assert.equal(owen.guess?.address, `owen.park@${SITE}`)
})

test("#1036 off by default and tenant scoped: without EMAIL_GUESS_ENABLED nothing is guessed, stored or shown; another tenant's lead never sees this tenant's guess", async () => {
  const s = seed(); twoConfirmed(s.db)
  const off = await findWorkEmail(s.db, 'A', s.lead, DANA, { env: {}, now: NOW })
  assert.equal(off.status, 'no_key'); assert.equal(off.guess, undefined)
  assert.equal(n(s.db, "SELECT count(*) AS n FROM email_candidates WHERE tier = 'guessed'"), 0)
  await findWorkEmail(s.db, 'A', s.lead, DANA, { env: ON, now: NOW })
  assert.equal(guessesForLead(s.db, 'A', s.lead, {}).length, 0, 'flag off: a stored guess is not shown either')
  assert.equal(guessFor(s.db, 'B', s.lead, 'Dana Lee', ON), null, "another tenant's read of this lead finds nothing")
  assert.deepEqual(guessesForLead(s.db, 'B', s.lead, ON), [])
})

test("#1036 guess guards: a person with a confirmed address is not guessed; no US basis, no guess; an address two named people could own, or someone else's confirmed address: no guess", async () => {
  // Dana's own confirmed address: that is the published tier
  const a = seed(); twoConfirmed(a.db); published(a.db, 'A', 'other-lead', 'Dana Lee, Practice Manager', `dana.lee@${SITE}`)
  assert.equal((await findWorkEmail(a.db, 'A', a.lead, DANA, { env: ON, now: NOW })).guess, undefined)
  // a format whose supporting rows carry no US basis
  const b = seed(); published(b.db, 'A', 'x', 'Pat Kim, Owner', `pat.kim@${SITE}`, undefined, null); published(b.db, 'A', 'x', 'Sue Ray, Partner', `sue.ray@${SITE}`, undefined, null)
  assert.equal((await findWorkEmail(b.db, 'A', b.lead, DANA, { env: ON, now: NOW })).guess, undefined, 'unknown country counts as not US')
  // two named people on the lead who could both own the guessed address (dlee for Dana Lee and Dean Lee)
  const d = seed(); published(d.db, 'A', 'x', 'Pat Kim, Owner', `pkim@${SITE}`); published(d.db, 'A', 'x', 'Sue Ray, Partner', `sray@${SITE}`)
  d.db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, confidence, source_url, source_date, retrieved_at) VALUES (?, ?, 'A', 'sitecrawl', 'person', 'Dean Lee, Owner', 70, ?, '2026-11-01', ?)").run(randomBytes(12).toString('hex'), d.lead, `https://${SITE}/team`, NOW)
  assert.equal(learnedFormat(d.db, 'A', SITE)!.format, 'flast')
  assert.equal((await findWorkEmail(d.db, 'A', d.lead, DANA, { env: ON, now: NOW })).guess, undefined, "pkim-style dlee@ could be Dana's or Dean's: nobody's")
  assert.equal((await findWorkEmail(d.db, 'A', d.lead, 'Owen Park|Owner', { env: ON, now: NOW })).guess?.address, `opark@${SITE}`, 'an unambiguous person still gets one')
  // an address someone else already has confirmed is never offered as another person's guess
  const e = seed(); twoConfirmed(e.db); published(e.db, 'A', 'x', 'Dan Elee, Partner', `dana.lee@${SITE}`)
  assert.equal((await findWorkEmail(e.db, 'A', e.lead, DANA, { env: ON, now: NOW })).guess, undefined)
  assert.equal(guessFromLearnedFormat(e.db, 'A', e.lead, { name: 'Dana Lee', title: null }, 'not a domain', [], ON), null)
})

test('#1036 labels: a guess is "guessed, unverified" until a mailbox check says valid, then "guessed, verified" with who and when; undeliverable and refused are never shown; catch-all and unfinished checks stay unverified and say why', async () => {
  const s = seed(); twoConfirmed(s.db)
  const first = await findWorkEmail(s.db, 'A', s.lead, DANA, { env: ON, now: NOW })
  const addr = first.guess!.address
  const set = (verification: string, verifier: string | null = 'zerobounce', at: number | null = NOW) => s.db.prepare('UPDATE email_candidates SET verification = ?, verifier = ?, checked_at = ? WHERE address = ?').run(verification, verifier, at, addr)
  const view = () => guessFor(s.db, 'A', s.lead, 'Dana Lee', ON)
  assert.equal(view()!.label, 'guessed, unverified')
  set('verified'); assert.deepEqual([view()!.label, view()!.state, view()!.verifier, view()!.checked_at], ['guessed, verified', 'verified', 'zerobounce', NOW])
  set('verified', null, null); assert.equal(view()!.label, 'guessed, unverified', 'verified without its verifier and time is not verified')
  set('catch_all'); assert.deepEqual([view()!.label, view()!.state], ['guessed, unverified', 'catch_all'])
  set('uncertain'); assert.deepEqual([view()!.label, view()!.state], ['guessed, unverified', 'uncertain'])
  set('pending'); assert.deepEqual([view()!.label, view()!.state], ['guessed, unverified', 'uncertain'])
  set('undeliverable'); assert.equal(view(), null, 'a mailbox that does not exist is never shown')
  set('refused'); assert.equal(view(), null, 'a do-not-mail address is never shown')
  assert.deepEqual(guessesForLead(s.db, 'A', s.lead, ON), [])
  set('verified')
  assert.notEqual(view()!.label as string, 'published', 'a guess is never published, whatever the row says')
  // the copy: only a verified guess reads as checked; unverified says nothing confirmed the mailbox and that dazl does not draft to it
  const shown = view() as GuessShown
  assert.equal(guessCopy(shown).checked, true); assert.match(guessCopy(shown).note, /confirmed the mailbox accepts mail on 2027-01-15/); assert.match(guessCopy(shown).note, /dazl does not draft to it/)
  const un = guessCopy({ ...shown, label: 'guessed, unverified', state: 'catch_all', verifier: null, checked_at: null })
  assert.equal(un.checked, false); assert.match(un.note, /nothing confirmed that this mailbox exists/); assert.match(un.note, /catch-all/); assert.match(un.note, /Do not send to it unverified/)
  assert.match(un.learned, /Format learned from pat\.kim@harbordental\.example and sue\.ray@harbordental\.example/)
})

test('#1036 the panel: a guess has no Copy unless it is verified, is shown only where nothing was found, and outreach never reads guesses', () => {
  const tsx = readFileSync(new URL('../app/app/leads/work-email.tsx', import.meta.url), 'utf8')
  assert.match(tsx, /\{c\.checked && <button[^>]*onClick=\{\(\) => void copy\(g\.address\)\}/, 'Copy only for a checked guess')
  assert.match(tsx, /if \(!g \|\| \(l && l\.address && v\?\.showAddress\)\) return null/, 'a found address is never joined by a guess')
  for (const f of ['lib/outreach/service.ts', 'lib/outreach/published-email.ts', 'lib/outreach/autopilot.ts']) assert.doesNotMatch(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'), /email_candidates|email-formats|guessFor/, f)
})

test('#1036 mailbox-check counter: honest when nothing can run (off, no verifier, caps 0), counts exactly what the cap counts, goes up by the checks made and stops at the cap', async () => {
  const s = seed(); const db = sqliteDb(s.db)
  const u = (env: Record<string, string>, now = NOW, tenant = 'A') => mailboxCheckUsage(db, tenant, env, now)
  const off = await u({}); assert.deepEqual([off.state, off.verifier, off.day.used, off.day.cap, off.month.used], ['off', null, 0, 0, 0]); assert.match(off.note, /no mailbox check runs and none is counted/)
  assert.equal((await u({ EMAIL_GUESS_ENABLED: '1' })).state, 'no_verifier')
  const fake = { EMAIL_GUESS_ENABLED: '1', DAZL_ENV: 'staging', DAZL_STAGING_FAKE_ZEROBOUNCE: '1' }
  assert.equal((await u(fake)).state, 'daily_cap_zero'); assert.equal((await u({ ...fake, EMAIL_VERIFY_DAILY_CAP: '3' })).verifier, 'zerobounce-staging-fake')
  assert.equal((await u({ ...fake, EMAIL_VERIFY_DAILY_CAP: '3', EMAIL_VERIFY_MONTHLY_CAP: '0' })).state, 'monthly_cap_zero')
  const env = { ...fake, EMAIL_VERIFY_DAILY_CAP: '3', EMAIL_VERIFY_MONTHLY_CAP: '10' }
  const first = await u(env); assert.deepEqual([first.state, first.day, first.month.cap], ['active', { used: 0, cap: 3, remaining: 3 }, 10])
  // three checks, each reserved through the real cap: the counter goes up by exactly one each time and the fourth is refused
  const reserve = (i: number) => reserveVerifySlot(s.db, { tenantId: 'A', verifier: 'zerobounce-staging-fake', nowS: NOW, dailyCap: 3, monthCap: 10 }, () => s.db.prepare("INSERT INTO email_candidates (tenant_id, lead_id, person, address, format, country_basis, tier, checked_at, verification, verifier) VALUES ('A', 'l', 'P', ?, 'first.last', 'b', 'guessed', ?, 'pending', 'zerobounce-staging-fake')").run(`p${i}@${SITE}`, NOW).changes === 1)
  for (let i = 1; i <= 3; i++) { await reserve(i); const x = await u(env); assert.deepEqual([x.day.used, x.day.remaining, x.month.used], [i, 3 - i, i]) }
  await assert.rejects(() => reserve(4), (e: unknown) => e instanceof VerifySlotRefused)
  const spent = await u(env); assert.deepEqual([spent.state, spent.day.used, spent.day.remaining], ['day_spent', 3, 0])
  assert.equal((await u(env, NOW + 86_400)).state, 'active', 'the next UTC day: the daily count starts again')
  // a work-email lookup's mailbox check counts too, and another tenant's checks never do
  s.db.prepare("INSERT INTO work_email_lookups (tenant_id, lead_id, target, status, provider, address, mailbox_check, mailbox_verifier, mailbox_checked_at, updated_at) VALUES ('B', 'x', 'Q R|Owner', 'unverified', 'pdl', 'q@b.example', 'valid', 'zerobounce-staging-fake', ?, ?)").run(NOW, NOW)
  assert.equal((await u(env)).day.used, 3, "tenant B's check is not tenant A's")
  assert.equal((await u(env, NOW, 'B')).day.used, 1)
  assert.equal((await u({ ...env, EMAIL_VERIFY_MONTHLY_CAP: '3' })).state, 'month_spent')
})

test('#1036 the privacy text matches what ships: guessed candidates are unverified, never emailed, shown only for a buyer the site prints no address for, and only labelled', () => {
  const text = PRIVACY.flatMap(sec => sec.paragraphs).join('\n')
  assert.match(text, /labelled "guessed, unverified"/); assert.doesNotMatch(text, /never shown to you or emailed/)
})

test("#1036 review fixes: a one-name format builds no guess; a stored guess disappears once the person has a confirmed address; another tenant's confirmed addresses never teach this tenant's format", async () => {
  // 'first' format learned from two people: john@ could be any John on the site, so nobody gets it
  const a = seed(); published(a.db, 'A', 'x', 'Pat Kim, Owner', `pat@${SITE}`); published(a.db, 'A', 'x', 'Sue Ray, Partner', `sue@${SITE}`)
  assert.equal(learnedFormat(a.db, 'A', SITE)!.format, 'first')
  assert.equal((await findWorkEmail(a.db, 'A', a.lead, DANA, { env: ON, now: NOW })).guess, undefined)
  assert.equal(n(a.db, "SELECT count(*) n FROM email_candidates WHERE tier = 'guessed'"), 0)
  // a guess exists; the person's own address is then published: the guess is no longer shown
  const b = seed(); twoConfirmed(b.db)
  assert.equal((await findWorkEmail(b.db, 'A', b.lead, DANA, { env: ON, now: NOW })).guess?.address, `dana.lee@${SITE}`)
  assert.equal(guessesForLead(b.db, 'A', b.lead, ON).length, 1)
  published(b.db, 'A', b.lead, 'Dana Lee, Practice Manager', `dlee@${SITE}`)
  assert.equal(guessesForLead(b.db, 'A', b.lead, ON).length, 0)
  // tenant B's confirmed addresses teach tenant A nothing
  const c = seed(); twoConfirmed(c.db, 'B')
  assert.equal(learnedFormat(c.db, 'A', SITE), null)
  assert.equal((await findWorkEmail(c.db, 'A', c.lead, DANA, { env: ON, now: NOW })).guess, undefined)
})

test("#1036 review fixes 2: a crawl-written one-name guess and a guess a lookup flagged do-not-mail are never shown; the month figure is this workspace's own; only a missing table reads as zero; cap 0 and Off read honestly", async () => {
  const s = seed(); twoConfirmed(s.db)
  const ins = (person: string, address: string, format: string) => s.db.prepare("INSERT INTO email_candidates (tenant_id, lead_id, person, address, format, country_basis, tier, confidence) VALUES ('A', ?, ?, ?, ?, ?, 'guessed', 'low')").run(s.lead, person, address, format, BASIS)
  ins('Owen Park, Owner', `owen@${SITE}`, 'first')
  assert.equal(guessFor(s.db, 'A', s.lead, 'Owen Park', ON), null, 'one-name guesses written by the crawl are not shown either')
  ins('Dana Lee, Practice Manager', `dana.lee@${SITE}`, 'first.last')
  assert.equal(guessFor(s.db, 'A', s.lead, 'Dana Lee', ON)?.address, `dana.lee@${SITE}`)
  s.db.prepare("INSERT INTO work_email_lookups (tenant_id, lead_id, target, status, provider, address, checked_at, mailbox_check, updated_at) VALUES ('A', ?, 'Dana Lee|Practice Manager', 'verified', 'apollo', ?, ?, 'refused', ?)").run(s.lead, `dana.lee@${SITE}`, NOW, NOW)
  assert.equal(guessFor(s.db, 'A', s.lead, 'Dana Lee', ON), null, 'the same address flagged do-not-mail is not shown as a guess')
  // the month figure: this workspace only
  const t = seed(); const u = (env: Record<string, string>, tenant = 'A') => mailboxCheckUsage(sqliteDb(t.db), tenant, env, NOW)
  const fake = { EMAIL_GUESS_ENABLED: '1', DAZL_ENV: 'staging', DAZL_STAGING_FAKE_ZEROBOUNCE: '1', EMAIL_VERIFY_DAILY_CAP: '5', EMAIL_VERIFY_MONTHLY_CAP: '50' }
  assert.equal(Object.hasOwn((await u(fake)).month, 'remaining'), false, "no figure that carries another workspace's use")
  assert.match((await u({ ...fake, EMAIL_VERIFY_DAILY_CAP: '0' })).note, /daily limit is 0/)
  // a missing column is an error, not "0 used"
  const broken = new Database(':memory:'); broken.exec('CREATE TABLE email_candidates (tenant_id TEXT)'); broken.exec('CREATE TABLE work_email_lookups (tenant_id TEXT)')
  await assert.rejects(() => mailboxCheckUsage(sqliteDb(broken), 'A', fake, NOW))
  const panel = readFileSync(new URL('../app/app/settings/enrichment-panel.tsx', import.meta.url), 'utf8')
  assert.match(panel, /no checks allowed \(daily limit 0\)/); assert.match(panel, /state !== 'off' && <p data-testid="mailbox-checks-numbers"/)
})

test('#1036 review fixes 3: a foreign-area play gets no guess even with no key; a guess whose teaching evidence is gone or changed is hidden; the GET read works out each domain once', async () => {
  // a Canada-targeted play, no provider key: lookupWorkEmail returns no_key before its foreign check, so findWorkEmail must stop the guess
  const ca = seed(); twoConfirmed(ca.db)
  ca.db.prepare('UPDATE scan_jobs SET icp = ? WHERE id = ?').run(JSON.stringify({ ...ICP, where: ['Toronto, Canada'] }), ca.job)
  assert.equal((await findWorkEmail(ca.db, 'A', ca.lead, DANA, { env: ON, now: NOW })).guess, undefined, 'outside the US: published addresses only, no guess')
  assert.equal(n(ca.db, "SELECT count(*) n FROM email_candidates WHERE tier = 'guessed'"), 0, 'and nothing was stored')
  // the US play still gets its guess (control)
  const us = seed(); twoConfirmed(us.db)
  assert.equal((await findWorkEmail(us.db, 'A', us.lead, DANA, { env: ON, now: NOW })).guess?.address, `dana.lee@${SITE}`)
  // the evidence that taught the format is deleted: the invented address is no longer shown
  us.db.prepare("DELETE FROM email_candidates WHERE tier = 'published'").run()
  assert.deepEqual(guessesForLead(us.db, 'A', us.lead, ON), [])
  assert.equal(guessFor(us.db, 'A', us.lead, 'Dana Lee', ON), null)
  // a rival format takes over (the tenant now confirms first-initial-last addresses): the stored first.last guess is hidden
  const rival = seed(); twoConfirmed(rival.db)
  await findWorkEmail(rival.db, 'A', rival.lead, DANA, { env: ON, now: NOW })
  rival.db.prepare("DELETE FROM email_candidates WHERE tier = 'published'").run()
  published(rival.db, 'A', 'other-lead', 'Pat Kim, Owner', `pkim@${SITE}`); published(rival.db, 'A', 'other-lead', 'Sue Ray, Partner', `sray@${SITE}`)
  assert.equal(guessFor(rival.db, 'A', rival.lead, 'Dana Lee', ON), null, 'the stored guess was built on a format the evidence no longer supports')
  // many people on one lead: every shown guess is still returned (one read per domain, not per person)
  const many = seed(); twoConfirmed(many.db)
  for (const [p, a] of [['Dana Lee, Practice Manager', `dana.lee@${SITE}`], ['Owen Park, Owner', `owen.park@${SITE}`]]) many.db.prepare("INSERT INTO email_candidates (tenant_id, lead_id, person, address, format, country_basis, tier, confidence) VALUES ('A', ?, ?, ?, 'first.last', ?, 'guessed', 'high')").run(many.lead, p, a, BASIS)
  assert.deepEqual(guessesForLead(many.db, 'A', many.lead, ON).map(g => g.address).sort(), [`dana.lee@${SITE}`, `owen.park@${SITE}`])
})
