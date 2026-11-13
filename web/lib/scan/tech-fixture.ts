// TEST-ONLY technology-change fixture (#769 live check, Hermes-PC 2026-11-13 18:54Z: "a staging fixture site whose homepage the operator
// can switch (add a signature, remove it, serve a 503 or a consent wall), plus a way to crawl it several times in one session").
//
// No real site changes its stack on demand, so an adoption, a removal and an outage between two readable pages could never be seen
// live. This serves ONE fixture company's homepage in the variant the caller names and runs ONE real crawl of it: the unchanged
// crawlJob -> crawlSite -> recordTechObservation -> techChanges path (lib/connectors/sitecrawl.ts, lib/signals/tech-observations.ts).
// Only the HTTP fetch is local (the site is on the reserved .test TLD and resolves nowhere): robots handling, the homepage name check,
// the readability verdict, the detector, the dated tech_scan row and every tech_change row are the production code, writing the same
// rows a scan writes. No model, no search, no provider, nothing sent.
//
// Gate: DAZL_ENV=staging only (lib/staging.ts). Production never has it, so the fixture cannot run there. The lead is labelled test
// only (job marker industry/location 'test only' -> source_kind 'test'), lives in the caller's own workspace, has no contact and is
// never a draft candidate. deleteTechFixture removes every row the fixture and its crawls wrote.
//
// One fixture history shows ONE adoption and ONE removal. The rule treats a technology that comes back after a gap as the same install
// (tech-observations.ts), and a lead keeps one row per change, so serving `hubspot` again after a confirmed removal claims nothing new and
// the two dated rows stay as they are. Delete the fixture to start a fresh history.
import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import { isStaging } from '../staging.ts'
import { crawlJob, sitecrawlEnabled, techScanEnabled, TECH_AUDIT, type Get } from '../connectors/sitecrawl.ts'
import { audit } from '../connectors/store.ts'
import { FixtureError } from '../outreach/test-fixture.ts'
import { TECH_SCAN_KIND, TECH_CHANGE_KIND, decodeScan, day } from '../signals/tech-observations.ts'

export const TECH_FIXTURE_JOB = 'dazl tech fixture (test only)'
export const TECH_FIXTURE_COMPANY = 'dazl tech fixture (test only)'
export const TECH_FIXTURE_SITE = 'dazltechfixture.test'
export const TECH_FIXTURE_AUDIT = 'staging:tech-fixture'
const HOME = `https://${TECH_FIXTURE_SITE}/`
const SIGNAL = 'Test-only fixture for checking technology change detection on staging. Not a real company. dazl did not find, scrape or verify anything and claims no evidence.'

// What the fixture site's homepage serves for one crawl.
//   plain        a full readable page, no detectable technology
//   hubspot      the same page with HubSpot's forms embed (the script tag HubSpot's own embed code gives)
//   consent_wall HTTP 200, a cookie wall and nothing else: readable as HTML but too thin to say anything about absence (thin_page)
//   challenge    HTTP 200, a bot-challenge interstitial (blocked)
//   outage_503   HTTP 503 on every path, robots.txt included: the site is down
//   home_503     robots.txt answers, the homepage alone is HTTP 503
export const TECH_FIXTURE_PAGES = ['plain', 'hubspot', 'consent_wall', 'challenge', 'outage_503', 'home_503'] as const
export type TechFixturePage = typeof TECH_FIXTURE_PAGES[number]
export const isTechFixturePage = (x: unknown): x is TechFixturePage => typeof x === 'string' && (TECH_FIXTURE_PAGES as readonly string[]).includes(x)
// Whether the page a variant serves really carries the technology. null: the variant says nothing about the site's stack (it is down or walled).
const TRUTH: Record<TechFixturePage, boolean | null> = { plain: false, hubspot: true, consent_wall: null, challenge: null, outage_503: null, home_503: null }
const FIXTURE_TECH = 'HubSpot'

const BODY = `<main><h1>${TECH_FIXTURE_COMPANY}</h1>
<p>This page is a test-only fixture served by dazl's staging server for checking technology change detection. It is not a real company and nothing here is evidence of anything.</p>
<p>We help teams plan field service visits, keep customer records in one place and send appointment reminders. Our product is used by plumbing, heating and electrical contractors.</p>
<p>Book a walkthrough with our team, read the customer stories or see the pricing page for plans and limits.</p></main>`
const page = (head: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${TECH_FIXTURE_COMPANY}</title>${head}</head><body>${body}</body></html>`
export function techFixtureHtml(p: TechFixturePage): { status: number; body: string } {
  if (p === 'plain') return { status: 200, body: page('', BODY) }
  if (p === 'hubspot') return { status: 200, body: page('', `${BODY}<script charset="utf-8" type="text/javascript" src="//js.hsforms.net/forms/embed/v2.js"></script><script>hbspt.forms.create({ portalId: "0000000", formId: "00000000-0000-0000-0000-000000000000" });</script>`) }
  if (p === 'consent_wall') return { status: 200, body: page('', '<div id="consent"><h2>We value your privacy</h2><p>We use cookies to enhance your browsing experience.</p><button>Accept All</button><button>Reject All</button></div>') }
  if (p === 'challenge') return { status: 200, body: `<!doctype html><html lang="en-US"><head><title>Just a moment...</title></head><body><h1>${TECH_FIXTURE_COMPANY}</h1><p>Verifying you are human. This may take a few seconds.</p><p>${TECH_FIXTURE_COMPANY} needs to review the security of your connection before proceeding.</p><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></body></html>` }
  return { status: 503, body: '<html><head><title>503 Service Temporarily Unavailable</title></head><body><center><h1>503 Service Temporarily Unavailable</h1></center><hr><center>nginx</center></body></html>' }
}
// The crawl's fetcher for the fixture site, and only for it: any other host answers null (never a network call).
export function techFixtureGet(p: TechFixturePage): Get {
  return async (url) => {
    let u: URL; try { u = new URL(url) } catch { return null }
    if (u.protocol !== 'https:' || u.hostname !== TECH_FIXTURE_SITE) return null
    if (u.pathname === '/robots.txt') return p === 'outage_503' ? { status: 503, body: '', finalUrl: url } : { status: 404, body: 'Not Found', finalUrl: url }
    if (u.pathname === '/') return { ...techFixtureHtml(p === 'home_503' ? 'outage_503' : p), finalUrl: url }
    return { status: 404, body: 'Not Found', finalUrl: url }
  }
}

export const techFixtureOn = (env: Record<string, string | undefined> = process.env): boolean => isStaging(env)

function fixtureLead(db: Database.Database, tenantId: string): { jobId: string; leadId: string } | null {
  const r = db.prepare(`SELECT j.id AS job_id, l.id AS lead_id FROM scan_jobs j JOIN leads l ON l.scan_job_id = j.id
    WHERE j.user_id = ? AND j.business_name = ? AND j.industry = 'test only' AND j.location = 'test only'
      AND l.company = ? AND l.source_kind = 'test' ORDER BY j.created_at, j.id LIMIT 1`)
    .get(tenantId, TECH_FIXTURE_JOB, TECH_FIXTURE_COMPANY) as { job_id: string; lead_id: string } | undefined
  return r ? { jobId: r.job_id, leadId: r.lead_id } : null
}
function ensureLead(db: Database.Database, tenantId: string, now: number): { jobId: string; leadId: string } {
  return db.transaction(() => {
    const existing = fixtureLead(db, tenantId)
    if (existing) return existing
    const jobId = randomBytes(12).toString('hex'), leadId = randomBytes(12).toString('hex')
    // The leads table only accepts rows while its job is running; the job finishes immediately after.
    db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES (?, ?, ?, 'test only', 'test only', 'running')").run(jobId, tenantId, TECH_FIXTURE_JOB)
    db.prepare("INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, score, fit, intent, action, why, source_kind, created_at) VALUES (?, ?, '', ?, NULL, ?, ?, 50, 3, 3, 3, ?, 'test', ?)")
      .run(leadId, jobId, TECH_FIXTURE_COMPANY, SIGNAL, HOME, SIGNAL, now)
    db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ? AND status = 'running'").run(jobId)
    return { jobId, leadId }
  }).immediate()
}

export interface TechFixtureObservation { at: number; day: string; readability: string; technologies: string[] }
export interface TechFixtureChange { value: string; label: string | null; source_date: string }
export interface TechFixtureResult {
  job_id: string; lead_id: string; site: string; page: TechFixturePage
  // What this one crawl did: the crawl's own ledger status for the site ('ok', 'none_published', 'site_unreachable', 'robots_error', ...)
  // and the technology branch's own ledger status ('observed ok: 1 technologies, 1 changes; pages 1'; 'no_observation: ...' when the
  // homepage gave no verdict, as in an outage).
  crawl: { status: string | null; tech: string | null; new_observation: boolean; new_changes: string[] }
  observations: TechFixtureObservation[]
  changes: TechFixtureChange[]
  // Measured over every fixture crawl of this workspace's fixture lead. A claimed change is FALSE when the page served for that crawl
  // could not carry it: any change claimed on an unreadable or failed page, an addition claimed on a page without the technology, or a
  // removal claimed on a page that has it. The served page is the ground truth here, independent of the detector's own rule.
  measured: { crawls: number; unreadable_or_failed_crawls: number; changes_claimed: number; false_changes: number; changes_claimed_on_unreadable_or_failed: number }
}

const scans = (db: Database.Database, tenantId: string, leadId: string) =>
  (db.prepare("SELECT value, label, source_url FROM lead_enrichments WHERE tenant_id = ? AND lead_id = ? AND connector = 'sitecrawl' AND kind = ?").all(tenantId, leadId, TECH_SCAN_KIND) as { value: string; label: string | null; source_url: string }[])
    .map(r => decodeScan(r.value, r.label, r.source_url)).filter((s): s is NonNullable<typeof s> => !!s).sort((a, b) => a.at - b.at)
const changeRows = (db: Database.Database, tenantId: string, leadId: string) =>
  db.prepare("SELECT value, label, source_date FROM lead_enrichments WHERE tenant_id = ? AND lead_id = ? AND connector = 'sitecrawl' AND kind = ? ORDER BY retrieved_at, value").all(tenantId, leadId, TECH_CHANGE_KIND) as TechFixtureChange[]

// A change newly claimed by a crawl that served page p: is it one the served page could carry?
export const techFixtureFalseChange = (p: TechFixturePage, value: string): boolean => {
  const truth = TRUTH[p]
  if (truth === null) return true
  if (value === `${FIXTURE_TECH} added`) return truth !== true
  if (value === `${FIXTURE_TECH} removed`) return truth !== false
  return true // the fixture pages carry no other technology
}
const STATUS_RE = /^served ([a-z_0-9]+); new changes (\d+); false (\d+)$/
function measured(db: Database.Database, tenantId: string, jobId: string): TechFixtureResult['measured'] {
  const rows = db.prepare('SELECT status FROM connector_audit WHERE tenant_id = ? AND connector = ? AND scan_job_id = ?').all(tenantId, TECH_FIXTURE_AUDIT, jobId) as { status: string }[]
  const m = { crawls: 0, unreadable_or_failed_crawls: 0, changes_claimed: 0, false_changes: 0, changes_claimed_on_unreadable_or_failed: 0 }
  for (const r of rows) {
    const x = STATUS_RE.exec(r.status); if (!x || !isTechFixturePage(x[1])) continue
    m.crawls++; m.changes_claimed += Number(x[2]); m.false_changes += Number(x[3])
    if (TRUTH[x[1]] === null) { m.unreadable_or_failed_crawls++; m.changes_claimed_on_unreadable_or_failed += Number(x[2]) }
  }
  return m
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

// Serve the fixture homepage as `p` and crawl it once. Creates the fixture lead on first use.
export async function crawlTechFixture(db: Database.Database, tenantId: string, p: TechFixturePage, deps: { env?: Record<string, string | undefined>; now?: () => number; signal?: AbortSignal; get?: Get } = {}): Promise<TechFixtureResult> {
  const env = deps.env ?? process.env
  if (typeof tenantId !== 'string' || !tenantId || !techFixtureOn(env)) throw new FixtureError('staging_only')
  if (!isTechFixturePage(p)) throw new FixtureError('unknown_page')
  if (!sitecrawlEnabled(env)) throw new FixtureError('crawl_disabled')
  // With the technology branch switched off the crawl would run and record nothing: that is not "nothing changed".
  if (!techScanEnabled(env)) throw new FixtureError('tech_scan_disabled')
  // One fixture crawl per workspace at a time (in this process): two at once could date their observations to the same second,
  // where one is silently ignored, and would read each other's ledger rows.
  if (inFlight.has(tenantId)) throw new FixtureError('crawl_in_flight')
  inFlight.add(tenantId)
  try { return await crawlOnce(db, tenantId, p, env, deps) } finally { inFlight.delete(tenantId) }
}
const inFlight = new Set<string>()
async function crawlOnce(db: Database.Database, tenantId: string, p: TechFixturePage, env: Record<string, string | undefined>, deps: { now?: () => number; signal?: AbortSignal; get?: Get }): Promise<TechFixtureResult> {
  const clock = deps.now ?? Date.now
  const ids = ensureLead(db, tenantId, Math.floor(clock() / 1000))
  // An observation is dated to the second and one is kept per timestamp (tech-observations.ts): a crawl in the same second as the
  // last one would not be a new dated observation, so it waits for the next second instead of writing a row that is silently ignored.
  const before = scans(db, tenantId, ids.leadId)
  const last = before.length ? before[before.length - 1].at : 0
  // One clock read decides and dates the crawl (a wall clock can step back between two reads).
  let nowMs = clock()
  for (let i = 0; i < 50 && Math.floor(nowMs / 1000) <= last; i++) { await sleep(100); nowMs = clock() }
  if (Math.floor(nowMs / 1000) <= last) throw new FixtureError('clock_not_advancing')
  const changesBefore = new Set(changeRows(db, tenantId, ids.leadId).map(c => c.value))
  const mark = (db.prepare('SELECT COALESCE(MAX(insert_seq), 0) AS n FROM connector_audit').get() as { n: number }).n
  // The email finder is kept out of the fixture crawl (EMAIL_GUESS_ENABLED off for this call): it has nothing to find on these pages
  // and its rows live in a table the cleanup does not own.
  await crawlJob(db, tenantId, ids.jobId, { get: deps.get ?? techFixtureGet(p), gapMs: 0, env: { ...env, EMAIL_GUESS_ENABLED: '0' }, now: nowMs, signal: deps.signal, leads: [{ id: ids.leadId, company: TECH_FIXTURE_COMPANY, source_url: HOME }] })
  const ledger = db.prepare('SELECT connector, status FROM connector_audit WHERE insert_seq > ? AND tenant_id = ? AND scan_job_id = ? AND lookup = ? AND connector IN (?, ?) ORDER BY insert_seq').all(mark, tenantId, ids.jobId, TECH_FIXTURE_SITE, 'sitecrawl', TECH_AUDIT) as { connector: string; status: string }[]
  // A crawl that was cut short or failed inside writes no ledger row for the site (crawlJob returns early on an abort and only logs its
  // own errors). That is not an outage the site served: refuse it, never report it as "nothing changed".
  if (deps.signal?.aborted || !ledger.some(r => r.connector === 'sitecrawl')) throw new FixtureError('crawl_incomplete')
  const observations = scans(db, tenantId, ids.leadId)
  const changes = changeRows(db, tenantId, ids.leadId)
  const newChanges = changes.map(c => c.value).filter(v => !changesBefore.has(v))
  audit(db, { tenantId, connector: TECH_FIXTURE_AUDIT, jobId: ids.jobId, lookup: TECH_FIXTURE_SITE, status: `served ${p}; new changes ${newChanges.length}; false ${newChanges.filter(v => techFixtureFalseChange(p, v)).length}`, results: newChanges.length })
  return {
    job_id: ids.jobId, lead_id: ids.leadId, site: TECH_FIXTURE_SITE, page: p,
    crawl: { status: ledger.filter(r => r.connector === 'sitecrawl').pop()?.status ?? null, tech: ledger.filter(r => r.connector === TECH_AUDIT).pop()?.status ?? null, new_observation: observations.length > before.length, new_changes: newChanges },
    observations: observations.map(s => ({ at: s.at, day: day(s.at), readability: s.obs, technologies: s.present })),
    changes,
    measured: measured(db, tenantId, ids.jobId),
  }
}

// Removes the fixture's job and lead and every row its crawls wrote. Only on staging; only the caller's own workspace.
export function deleteTechFixture(db: Database.Database, tenantId: string, env: Record<string, string | undefined> = process.env): { deleted: boolean } {
  if (typeof tenantId !== 'string' || !tenantId || !techFixtureOn(env)) throw new FixtureError('staging_only')
  // A crawl still running would write its rows under the deleted ids, where no later cleanup could find them.
  if (inFlight.has(tenantId)) throw new FixtureError('crawl_in_flight')
  const ids = fixtureLead(db, tenantId)
  if (!ids) return { deleted: false }
  db.transaction(() => {
    db.prepare('DELETE FROM connector_audit WHERE tenant_id = ? AND scan_job_id = ?').run(tenantId, ids.jobId)
    db.prepare('DELETE FROM crawl_pages WHERE tenant_id = ? AND scan_job_id = ?').run(tenantId, ids.jobId)
    db.prepare('DELETE FROM lead_enrichments WHERE tenant_id = ? AND lead_id = ?').run(tenantId, ids.leadId)
    db.prepare('DELETE FROM leads WHERE id = ? AND scan_job_id = ?').run(ids.leadId, ids.jobId)
    db.prepare('DELETE FROM scan_jobs WHERE id = ? AND user_id = ?').run(ids.jobId, tenantId)
  }).immediate()
  return { deleted: true }
}
