import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import { fixtureAvailable, FixtureError } from '../outreach/test-fixture.ts'
import { migrateWorkEmail, PENDING_STALE_S, workEmailFixtureFakesOn, workEmailProviders } from '../people/work-email.ts'
import { migrateWarm } from '../warm/connections.ts'
import { WORK_EMAIL_FIXTURE_COMPANY } from '../people/work-email-eligible.ts'

// TEST-ONLY "Find work email" fixture (#1036 live check, Hermes 2026-11-13 09:21). The click flow can only be shown on staging
// with a lead that sits on a SETTLED company website AND names a buyer-role person, and no staging lead has both (a scan or CSV
// import spends the tenant's model key). This creates exactly one such lead, so the real Find work email route, the real
// staging fake People Data Labs (DAZL_STAGING_FAKE_PDL) and the real staging fake ZeroBounce (DAZL_STAGING_FAKE_ZEROBOUNCE)
// can be clicked through at $0. It inserts rows only: the lookup, the PDL answer, the mailbox check and every label run
// through the production code.
//
// Gated twice: the operator-designated test tenant (fixtureAvailable, the same gate as every other fixture) AND both staging fakes
// (work-email.ts workEmailFixtureFakesOn: DAZL_ENV=staging plus DAZL_STAGING_FAKE_PDL=1 and DAZL_STAGING_FAKE_ZEROBOUNCE=1).
// Production never has the second, so the fixture can never be created there, and work-email.ts refuses a lookup on this lead
// unless the same gates hold: no real Apollo / PDL key and no real ZeroBounce allowance is ever spent on it. The tenant needs a
// saved People Data Labs key (any string: the fake answers); the create response says whether one is saved.
//
// The lead (job marker industry/location 'test only' -> source_kind 'test'; company name says test only):
//   - one sitecrawl 'domain' row with the strongest recorded basis (the cited page is on that domain), so identityOf settles it;
//   - four buyer-role people read from the site's team page. Their first names drive the fake answers: the fake PDL returns
//     staging-<first>.<last>@<site>, and the fake ZeroBounce reads that local part: valid -> checked, catchall -> catch-all
//     ("Found, not checked"), invalid -> mailbox does not exist (address hidden), spamtrap -> do-not-mail (address hidden);
//   - a fifth person (Later) whose lookup is stored as already found by the fake PDL with the mailbox NOT yet checked, the state
//     the panel offers "Check mailbox" for; that click runs the real mailbox check against the fake ZeroBounce (valid).
// Nothing is drafted or sent: the lead has no contact and no crawled email, so it is never a draft candidate. Idempotent.
// deleteWorkEmailFixture removes every row it created, plus the lookups the real route stored for its lead.

export const WORK_EMAIL_FIXTURE_JOB = 'dazl work-email fixture (test only)'
export const WORK_EMAIL_FIXTURE_SITE = 'work-email-fixture.dazl-staging.test'
const SRC = `https://${WORK_EMAIL_FIXTURE_SITE}/`
const TEAM = `https://${WORK_EMAIL_FIXTURE_SITE}/team`
const SIGNAL = 'Test-only fixture for checking Find work email on staging. Not a real company or person. dazl did not find, scrape or verify anything and claims no evidence.'
export const WORK_EMAIL_FIXTURE_PEOPLE = [
  { name: 'Valid Testbuyer', title: 'Head of Sales', expect: 'checked work email (fake verifier: valid)' },
  { name: 'Catchall Testbuyer', title: 'VP of Sales', expect: 'found, not checked (fake verifier: catch-all)' },
  { name: 'Invalid Testbuyer', title: 'Director of Sales', expect: 'not shown: mailbox does not exist (fake verifier: invalid)' },
  { name: 'Spamtrap Testbuyer', title: 'Chief Revenue Officer', expect: 'not shown: do-not-mail (fake verifier: spamtrap)' },
  { name: 'Later Testbuyer', title: 'Head of Revenue', expect: 'found, not checked, with a Check mailbox button; the click gives a checked work email (fake verifier: valid)' },
] as const
// The person whose lookup the fixture stores as found-but-not-yet-checked (the Check mailbox path).
const LATER = WORK_EMAIL_FIXTURE_PEOPLE[4]

export interface WorkEmailFixture { jobId: string; leadId: string; created: boolean; site: string; pdlKeySaved: boolean; people: { name: string; title: string; target: string; expect: string }[] }

function fixtureLead(db: Database.Database, tenantId: string): { jobId: string; leadId: string } | null {
  const r = db.prepare(`SELECT j.id AS job_id, l.id AS lead_id FROM scan_jobs j JOIN leads l ON l.scan_job_id = j.id
    WHERE j.user_id = ? AND j.business_name = ? AND j.industry = 'test only' AND j.location = 'test only'
      AND l.company = ? AND l.source_kind = 'test' ORDER BY j.created_at, j.id LIMIT 1`)
    .get(tenantId, WORK_EMAIL_FIXTURE_JOB, WORK_EMAIL_FIXTURE_COMPANY) as { job_id: string; lead_id: string } | undefined
  return r ? { jobId: r.job_id, leadId: r.lead_id } : null
}

const pdlKeySaved = (db: Database.Database, tenantId: string): boolean =>
  !!db.prepare("SELECT 1 FROM tenant_connectors WHERE tenant_id = ? AND connector = 'enrich:pdl' AND enabled = 1 AND ciphertext <> ''").get(tenantId)
// Why the fixture cannot show its advertised outcomes here, or null when it can (xhawk review): a saved People Data Labs key (any
// string: the fake answers) and a mailbox check that can run now (EMAIL_GUESS_ENABLED, both caps above 0, the month's allowance left).
export function workEmailFixtureBlocker(db: Database.Database, tenantId: string, env: Record<string, string | undefined> = process.env): 'test_tenant_only' | 'staging_fakes_only' | 'needs_pdl_key' | 'needs_mailbox_check' | null {
  if (typeof tenantId !== 'string' || !tenantId || !fixtureAvailable(db, tenantId)) return 'test_tenant_only'
  if (!workEmailFixtureFakesOn(env)) return 'staging_fakes_only'
  if (!pdlKeySaved(db, tenantId)) return 'needs_pdl_key'
  if (!workEmailProviders(db, tenantId, env).mailboxCheck) return 'needs_mailbox_check'
  return null
}
export function workEmailFixtureAvailable(db: Database.Database, tenantId: string, env: Record<string, string | undefined> = process.env): boolean {
  return workEmailFixtureBlocker(db, tenantId, env) === null
}

const describe = (db: Database.Database, tenantId: string, ids: { jobId: string; leadId: string }, created: boolean): WorkEmailFixture => ({
  ...ids, created, site: WORK_EMAIL_FIXTURE_SITE, pdlKeySaved: pdlKeySaved(db, tenantId),
  people: WORK_EMAIL_FIXTURE_PEOPLE.map(p => ({ name: p.name, title: p.title, target: `${p.name}|${p.title}`, expect: p.expect })),
})

export function createWorkEmailFixture(db: Database.Database, tenantId: string, env: Record<string, string | undefined> = process.env, now = Math.floor(Date.now() / 1000)): WorkEmailFixture {
  migrateWorkEmail(db)
  const blocker = workEmailFixtureBlocker(db, tenantId, env)
  if (blocker) throw new FixtureError(blocker)
  return db.transaction((): WorkEmailFixture => {
    const existing = fixtureLead(db, tenantId)
    if (existing) return describe(db, tenantId, existing, false)
    const jobId = randomBytes(12).toString('hex')
    const leadId = randomBytes(12).toString('hex')
    const today = new Date(now * 1000).toISOString().slice(0, 10)
    db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES (?, ?, ?, 'test only', 'test only', 'running')").run(jobId, tenantId, WORK_EMAIL_FIXTURE_JOB)
    db.prepare("INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, score, fit, intent, action, source_kind, created_at) VALUES (?, ?, '', ?, NULL, ?, ?, 90, 4, 3, 3, 'test', ?)")
      .run(leadId, jobId, WORK_EMAIL_FIXTURE_COMPANY, SIGNAL, SRC, now)
    const enr = db.prepare('INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES (?, ?, ?, ?, ?, ?, ?, 70, ?, ?, ?)')
    // The strongest recorded website basis (published-email.ts domainBasisFor 'own_domain'): identityOf -> state 'fact'.
    enr.run(randomBytes(12).toString('hex'), leadId, tenantId, 'sitecrawl', 'domain', `${WORK_EMAIL_FIXTURE_SITE}|evidence_own_domain`, 'domain-basis-v1:evidence_own_domain', SRC, today, now)
    for (const p of WORK_EMAIL_FIXTURE_PEOPLE) enr.run(randomBytes(12).toString('hex'), leadId, tenantId, 'sitecrawl', 'person', `${p.name}, ${p.title}`, 'Test fixture', TEAM, today, now)
    // Later: found earlier by the fake PDL (provider 'pdl', 'unverified'), mailbox not yet checked (mailbox_check NULL) -> Check mailbox.
    db.prepare("INSERT INTO work_email_lookups (tenant_id, lead_id, target, status, provider, address, detail, updated_at) VALUES (?, ?, ?, 'unverified', 'pdl', ?, ?, ?)")
      .run(tenantId, leadId, `${LATER.name}|${LATER.title}`, `staging-later.testbuyer@${WORK_EMAIL_FIXTURE_SITE}`, 'test-only fixture: stored as found by the staging fake People Data Labs before any mailbox check', now)
    db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ? AND status = 'running'").run(jobId)
    return describe(db, tenantId, { jobId, leadId }, true)
  })()
}

export function workEmailFixtureExists(db: Database.Database, tenantId: string): boolean {
  return !!fixtureLead(db, tenantId)
}

// Removes the fixture's job, lead and enrichments and the lookups stored for its lead. Only the test tenant may; nothing else is touched.
export function deleteWorkEmailFixture(db: Database.Database, tenantId: string): { deleted: boolean } {
  if (!fixtureAvailable(db, tenantId)) throw new FixtureError('test_tenant_only')
  const ids = fixtureLead(db, tenantId)
  if (!ids) return { deleted: false }
  migrateWorkEmail(db); migrateWarm(db)
  // A lookup still running on this lead (a fresh 'pending' row, or a mailbox check in flight) would finish against deleted rows:
  // refuse until it ends (xhawk review). A stale pending row (past PENDING_STALE_S) belongs to a lookup that died.
  const now = Math.floor(Date.now() / 1000)
  const inFlight = db.prepare("SELECT 1 FROM work_email_lookups WHERE tenant_id = ? AND lead_id = ? AND ((status = 'pending' AND updated_at >= ?) OR (mailbox_check = 'pending' AND COALESCE(mailbox_checked_at, 0) >= ?)) LIMIT 1")
    .get(tenantId, ids.leadId, now - PENDING_STALE_S, now - PENDING_STALE_S)
  if (inFlight) throw new FixtureError('lookup_in_flight')
  db.transaction(() => {
    db.prepare('DELETE FROM work_email_lookups WHERE tenant_id = ? AND lead_id = ?').run(tenantId, ids.leadId)
    // Rows the real panels next to it may have attached to this lead (warm paths, source credits).
    db.prepare('DELETE FROM warm_user_paths WHERE tenant_id = ? AND lead_id = ?').run(tenantId, ids.leadId)
    db.prepare('DELETE FROM lead_sources WHERE lead_id = ?').run(ids.leadId)
    db.prepare('DELETE FROM lead_enrichments WHERE tenant_id = ? AND lead_id = ?').run(tenantId, ids.leadId)
    db.prepare('DELETE FROM leads WHERE id = ? AND scan_job_id = ?').run(ids.leadId, ids.jobId)
    db.prepare('DELETE FROM scan_jobs WHERE id = ? AND user_id = ?').run(ids.jobId, tenantId)
  })()
  return { deleted: true }
}
