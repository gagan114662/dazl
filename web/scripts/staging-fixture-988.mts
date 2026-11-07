// #988 staging sample-data loader (DRY-RUN by default). Inserts ONE clearly tagged synthetic saved run with four leads that cover the date cases the app pages must render
// (future / recent / old / missing event date) into the EXISTING staging QA workspace, and nothing else.
//
//   Plan only (default):  DAZL_ENV=staging DB_PATH=/var/lib/dazl-staging/app.db node --experimental-strip-types scripts/staging-fixture-988.mts
//   Apply (after review): ... scripts/staging-fixture-988.mts --apply --tenant-id=<id printed by the plan>
//
// Guards (all must hold, each refuses with a named reason and writes nothing):
//   - DAZL_ENV is exactly 'staging' (lib/staging.ts); production, unset or anything else refuses;
//   - DB_PATH is set, names an existing file, and its path contains '/staging' or 'dazl-staging' (a production database path refuses);
//   - real staging Gmail is OFF (DAZL_STAGING_REAL_GMAIL must not be '1'): this tool never runs next to a live mail path;
//   - the tenant is the one existing user whose email is exactly QA_EMAIL; it is never created, and exactly one must match;
//   - --apply additionally needs --tenant-id equal to that user's id (a plan names the id; applying a different one refuses).
// Writes (inside ONE transaction; any failure rolls everything back): scan_jobs +1 row, leads +4 rows. Nothing else: no user, setting, key, consent, trial, send, schedule or worker row.
// FKs: scan_jobs.user_id -> users.id (existing tenant), leads.scan_job_id -> scan_jobs.id (the fixture job). Fixed ids make a repeat run a no-op; the job is born 'done' (never 'pending'/'running'),
// so no runner can claim it, and no timer, provider call, send or network request is made. Contacts and evidence use reserved example.com / .test domains only.
// No delete, replace or cleanup exists in this tool.
import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { isStaging } from '../lib/staging.ts'

export const QA_EMAIL = 'instinct114114@gmail.com'
export const FIXTURE_TAG = 'SYNTHETIC #988'
export const JOB_ID = 'f988f988f988f988f988f9a0'   // 24 hex like production ids; fixed so a repeat is a no-op
const DAY = 86_400
export interface FixtureLead { id: string; name: string; company: string; contact: string; signal: string; source_url: string; evidence_excerpt: string; event_date: string | null; date_status: 'verified' | 'unverified' | 'undated'; dedup_key: string; case: 'future' | 'recent' | 'old' | 'missing' }
export interface Env { DAZL_ENV?: string; DB_PATH?: string; DAZL_STAGING_REAL_GMAIL?: string }

export class FixtureRefused extends Error {
  reason: string
  constructor(reason: string, detail: string) { super(`staging-fixture-988: refused (${reason}): ${detail}`); this.reason = reason }
}
const iso = (now: number, days: number) => new Date((now + days * DAY) * 1000).toISOString().slice(0, 10)
export function fixtureLeads(now: number): FixtureLead[] {
  const mk = (n: number, c: FixtureLead['case'], days: number | null, status: FixtureLead['date_status'], signal: string): FixtureLead => ({
    id: `f988f988f988f988f988f9b${n}`, name: `${FIXTURE_TAG} contact ${n}`, company: `${FIXTURE_TAG} Co ${n} (${c} date)`, contact: `lead-${n}@fixture-${n}.example.com`, signal,
    source_url: `https://fixture-${n}.example.test/${c}-date`, evidence_excerpt: `${FIXTURE_TAG} fake evidence for the ${c}-date case. Not a real company, page or person.`,
    event_date: days === null ? null : iso(now, days), date_status: status, dedup_key: `fixture-988:${c}`, case: c,
  })
  return [mk(1, 'future', 30, 'unverified', 'Synthetic: event dated in the future'), mk(2, 'recent', -3, 'verified', 'Synthetic: event dated three days ago'),
    mk(3, 'old', -400, 'verified', 'Synthetic: event dated more than a year ago'), mk(4, 'missing', null, 'undated', 'Synthetic: no event date')]
}
export interface Plan { tenant: string; email: string; job: { id: string; exists: boolean }; leads: { id: string; case: string; exists: boolean }[]; expected: { scan_jobs: number; leads: number }; mode: 'dry-run' | 'apply' }

export function checkEnvironment(env: Env): void {
  if (!isStaging(env as Record<string, string | undefined>)) throw new FixtureRefused('not_staging', `DAZL_ENV must be exactly 'staging' (got ${JSON.stringify(env.DAZL_ENV ?? null)})`)
  const p = env.DB_PATH ?? ''
  if (!p) throw new FixtureRefused('no_db_path', 'DB_PATH is not set')
  if (!/staging/i.test(p)) throw new FixtureRefused('not_a_staging_database', `DB_PATH does not name the staging store: ${p}`)
  if (env.DAZL_STAGING_REAL_GMAIL === '1') throw new FixtureRefused('real_gmail_on', 'real staging Gmail must be OFF while this tool runs')
}
export function resolveTenant(raw: Database.Database): string {
  const rows = raw.prepare('SELECT id FROM users WHERE lower(email) = ?').all(QA_EMAIL) as { id: string }[]
  if (rows.length !== 1) throw new FixtureRefused(rows.length ? 'ambiguous_tenant' : 'tenant_missing', `expected exactly one ${QA_EMAIL} user, found ${rows.length}; this tool never creates a tenant`)
  return rows[0].id
}
export function plan(raw: Database.Database, env: Env, now: number, mode: 'dry-run' | 'apply' = 'dry-run'): Plan {
  checkEnvironment(env)
  const tenant = resolveTenant(raw)
  const job = raw.prepare('SELECT user_id FROM scan_jobs WHERE id = ?').get(JOB_ID) as { user_id: string } | undefined
  if (job && job.user_id !== tenant) throw new FixtureRefused('job_owned_by_other_tenant', 'the fixture job id already belongs to a different user')
  const leads = fixtureLeads(now).map(l => {
    const e = raw.prepare('SELECT scan_job_id FROM leads WHERE id = ?').get(l.id) as { scan_job_id: string } | undefined
    if (e && e.scan_job_id !== JOB_ID) throw new FixtureRefused('lead_id_in_use', `lead id ${l.id} belongs to another job`)
    return { id: l.id, case: l.case, exists: !!e }
  })
  // The leads trigger only accepts leads for a RUNNING job, so a job that already exists is never reopened: a partial earlier state is reported, not repaired.
  if (job && leads.some(l => !l.exists)) throw new FixtureRefused('partial_fixture', 'the fixture job exists but some of its leads are missing; this tool never reopens a finished job (review by hand)')
  return { tenant, email: QA_EMAIL, job: { id: JOB_ID, exists: !!job }, leads, expected: { scan_jobs: job ? 0 : 1, leads: leads.filter(l => !l.exists).length }, mode }
}
export function apply(raw: Database.Database, env: Env, tenantId: string | undefined, now: number): Plan & { applied: { scan_jobs: number; leads: number } } {
  const p = plan(raw, env, now, 'apply')
  if (!tenantId) throw new FixtureRefused('tenant_id_required', `--tenant-id=${p.tenant} is required to apply`)
  if (tenantId !== p.tenant) throw new FixtureRefused('tenant_id_mismatch', 'the given tenant id is not the QA workspace')
  const applied = { scan_jobs: 0, leads: 0 }
  raw.transaction(() => {
    // re-read inside the transaction so the plan and the write cannot disagree
    const again = plan(raw, env, now, 'apply'); if (again.tenant !== p.tenant) throw new FixtureRefused('tenant_changed', 'tenant changed during apply')
    if (!again.job.exists) {
      // Same lifecycle as the production writer (finishJob): the job is 'running' only INSIDE this transaction (the leads trigger requires it), and is 'done' when the transaction commits. No other
      // connection ever sees a pending or running fixture job, so no runner can claim it.
      applied.scan_jobs += raw.prepare(
        `INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, icp, icp_inferred, status, attempts, claimed_at, created_at)
         VALUES (?, ?, ?, '(from request)', '-', ?, ?, 0, 'running', 1, ?, ?)`)
        .run(JOB_ID, p.tenant, `${FIXTURE_TAG} saved run`.slice(0, 150), `${FIXTURE_TAG}: fixture run for the date cases (not a real search)`, JSON.stringify({ summary: `${FIXTURE_TAG} fixture profile (not a real buyer profile)`, who: [], industries: [], sizes: [], where: [], signals: [], exclude: [] }), now - 3600, now - 3600).changes
      for (const l of fixtureLeads(now)) {
        applied.leads += raw.prepare(
          `INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, score, evidence_excerpt, event_date, date_status, retrieved_at, confidence, dedup_key, fit, intent, action, why, signal_kind, source_kind, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 60, ?, ?, ?, ?, 80, ?, 3, 3, 3, ?, 'expansion', 'company_site', ?) ON CONFLICT DO NOTHING`)
          .run(l.id, JOB_ID, l.name, l.company, l.contact, l.signal, l.source_url, l.evidence_excerpt, l.event_date, l.date_status, now - 7200, l.dedup_key, `${l.signal} (${FIXTURE_TAG})`, now - 3600).changes
      }
      raw.prepare("UPDATE scan_jobs SET status = 'done', error = NULL, claimed_at = NULL, candidates = 4, verified = 4, needs_review = 0, dropped = 0, finished_at = ? WHERE id = ? AND status = 'running'").run(now - 60, JOB_ID)
    }
  }).immediate()
  return { ...p, applied }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2), doApply = args.includes('--apply'), tenantId = args.find(a => a.startsWith('--tenant-id='))?.slice(12)
  const env: Env = { DAZL_ENV: process.env.DAZL_ENV, DB_PATH: process.env.DB_PATH, DAZL_STAGING_REAL_GMAIL: process.env.DAZL_STAGING_REAL_GMAIL }
  let raw: Database.Database | null = null
  try {
    checkEnvironment(env)
    if (!existsSync(env.DB_PATH!)) throw new FixtureRefused('db_missing', 'DB_PATH does not exist; this tool never creates a database')
    raw = new Database(env.DB_PATH!, { fileMustExist: true })
    raw.pragma('foreign_keys = ON')
    const now = Math.floor(Date.now() / 1000)
    console.log(JSON.stringify(doApply ? apply(raw, env, tenantId, now) : plan(raw, env, now), null, 2))
    if (!doApply) console.log('DRY-RUN: nothing was written. Re-run with --apply --tenant-id=<tenant above> after review.')
  } catch (e) { console.error(e instanceof Error ? e.message : e); process.exitCode = e instanceof FixtureRefused ? 3 : 1 } finally { raw?.close() }
}
