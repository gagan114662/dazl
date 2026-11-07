// #988 staging sample-data loader (DRY-RUN by default). Inserts ONE clearly tagged synthetic saved run with four leads that cover the date cases the app pages must render
// (future / recent / old / missing event date) into the EXISTING staging QA workspace, and nothing else.
//
//   Plan only (default):  DAZL_ENV=staging DB_PATH=/var/lib/dazl-staging/app.db node --experimental-strip-types scripts/staging-fixture-988.mts
//   Apply (after review): ... scripts/staging-fixture-988.mts --apply --tenant-id=<id printed by the plan>
//
// Guards (all must hold, each refuses with a named reason and writes nothing):
//   - DAZL_ENV is exactly 'staging' (lib/staging.ts); production, unset or anything else refuses;
//   - DB_PATH is EXACTLY the staging database, /var/lib/dazl-staging/app.db (no pattern: a look-alike, relative, traversal or backup path refuses), and the file's real path (symlinks resolved) is that same path;
//   - real staging Gmail is OFF (DAZL_STAGING_REAL_GMAIL must not be '1'): this tool never runs next to a live mail path;
//   - the tenant is the one existing user whose email is exactly QA_EMAIL; it is never created, and exactly one must match;
//   - --apply additionally needs --tenant-id equal to that user's id (a plan names the id; applying a different one refuses).
// Writes (inside ONE transaction; any failure rolls everything back): scan_jobs +1 row, leads +4 rows. Nothing else: no user, setting, key, consent, trial, send, schedule or worker row.
// FKs: scan_jobs.user_id -> users.id (existing tenant), leads.scan_job_id -> scan_jobs.id (the fixture job). Fixed ids make a repeat run a no-op; the job is born 'done' (never 'pending'/'running'),
// so no runner can claim it, and no timer, provider call, send or network request is made. Contacts and evidence use reserved example.com / .test domains only.
// No delete, replace or cleanup exists in this tool.
import Database from 'better-sqlite3'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { posix } from 'node:path'
import { isStaging } from '../lib/staging.ts'

export const QA_EMAIL = 'instinct114114@gmail.com'
export const FIXTURE_TAG = 'SYNTHETIC #988'
export const STAGING_DB_PATH = '/var/lib/dazl-staging/app.db'
export const JOB_ID = 'f988f988f988f988f988f9a0'   // 24 hex like production ids; fixed so a repeat is a no-op
const DAY = 86_400
const FIXTURE_ICP = { summary: `${FIXTURE_TAG} fixture profile (not a real buyer profile)`, who: [], industries: [], sizes: [], where: [], signals: [], exclude: [] }
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
  if (p !== STAGING_DB_PATH || posix.normalize(p) !== STAGING_DB_PATH) throw new FixtureRefused('not_the_staging_database', `DB_PATH must be exactly ${STAGING_DB_PATH} (got ${JSON.stringify(p)})`)
  if (env.DAZL_STAGING_REAL_GMAIL === '1') throw new FixtureRefused('real_gmail_on', 'real staging Gmail must be OFF while this tool runs')
}
// The file the path resolves to must be that same database (a symlink or bind that points elsewhere refuses). `real` is injectable so the check is testable without that file.
export function checkDbFile(p: string, real: (x: string) => string = realpathSync): void {
  let r: string; try { r = real(p) } catch { throw new FixtureRefused('db_missing', `cannot resolve ${p}; this tool never creates a database`) }
  if (r !== STAGING_DB_PATH) throw new FixtureRefused('db_path_resolves_elsewhere', `${p} resolves to ${r}`)
}
// The OPENED database must be the staging file, not just a path that looked right: its identity (device:inode, a single hard link) must equal the identity the reviewed host wrapper recorded for
// the real staging file, differ from the production file's, and be the file this connection actually has open (PRAGMA database_list). It is re-checked INSIDE the apply transaction.
export interface Identity { dev: number; ino: number; nlink: number }
export interface Binding { expect: string; production: string | null; stat?: (p: string) => Identity; opened?: (raw: Database.Database) => string }
const idOf = (i: Identity) => `${i.dev}:${i.ino}`
const statId = (p: string): Identity => { const s = statSync(p); return { dev: s.dev, ino: s.ino, nlink: s.nlink } }
const openedFile = (raw: Database.Database): string => ((raw.prepare('PRAGMA database_list').all() as { name: string; file: string }[]).find(d => d.name === 'main')?.file) ?? ''
export function checkBinding(raw: Database.Database, b: Binding | undefined): void {
  if (!b || !b.expect) throw new FixtureRefused('identity_binding_missing', 'the host wrapper must supply DAZL_FIXTURE_DB_IDENTITY (device:inode of the staging file)')
  const file = (b.opened ?? openedFile)(raw)
  if (file !== STAGING_DB_PATH) throw new FixtureRefused('opened_handle_elsewhere', `this connection has ${JSON.stringify(file)} open, not ${STAGING_DB_PATH}`)
  const id = (b.stat ?? statId)(file)
  if (id.nlink !== 1) throw new FixtureRefused('hard_linked', `the staging file has ${id.nlink} hard links`)
  if (idOf(id) !== b.expect) throw new FixtureRefused('identity_mismatch', `the opened file is ${idOf(id)}, the wrapper recorded ${b.expect}`)
  if (b.production && idOf(id) === b.production) throw new FixtureRefused('is_production_file', 'the opened file has the production database identity')
}
export function resolveTenant(raw: Database.Database): string {
  const rows = raw.prepare('SELECT id FROM users WHERE lower(email) = ?').all(QA_EMAIL) as { id: string }[]
  if (rows.length !== 1) throw new FixtureRefused(rows.length ? 'ambiguous_tenant' : 'tenant_missing', `expected exactly one ${QA_EMAIL} user, found ${rows.length}; this tool never creates a tenant`)
  return rows[0].id
}
const LEAD_CHECKED = ['id', 'scan_job_id', 'name', 'company', 'contact', 'signal', 'source_url', 'score', 'evidence_excerpt', 'date_status', 'confidence', 'dedup_key', 'fit', 'intent', 'action', 'why', 'signal_kind', 'source_kind', 'event_date', 'retrieved_at', 'created_at']
const JOB_CHECKED = ['id', 'user_id', 'business_name', 'industry', 'location', 'query', 'icp', 'icp_inferred', 'status', 'attempts', 'claimed_at', 'error', 'candidates', 'verified', 'needs_review', 'dropped', 'created_at', 'finished_at']
type Row = Record<string, unknown>
// Columns this tool does not set must still be at their default (NULL, or the declared default): a row somebody else edited or enriched is not "ours".
function unsetColumnsAtDefault(raw: Database.Database, table: string, row: Row, checked: string[]): string | null {
  const cols = raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string; dflt_value: string | null }[]
  for (const c of cols) {
    if (checked.includes(c.name) || c.name === 'insert_seq') continue
    const dflt = c.dflt_value === null ? null : c.dflt_value.replace(/^'(.*)'$/, '$1')
    if (!(row[c.name] === null || row[c.name] === undefined || (dflt !== null && String(row[c.name]) === dflt))) return `${table}.${c.name} is ${JSON.stringify(row[c.name])}`
  }
  return null
}
// The event date is relative to the day the tool ran, so an existing row is checked by CLASS, not by the literal date.
function dateClassOk(c: FixtureLead['case'], v: unknown, status: unknown, now: number): boolean {
  if (c === 'missing') return v === null && status === 'undated'
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const days = Math.floor((Date.parse(`${v}T00:00:00Z`) - now * 1000) / (DAY * 1000))
  return c === 'future' ? days > 0 && status === 'unverified' : c === 'recent' ? days <= 0 && days >= -60 && status === 'verified' : days < -180 && status === 'verified'
}
// An existing fixture is accepted ONLY if every field of the job and each lead is exactly what this tool writes, it is owned by the QA tenant, and nothing else hangs off it.
export function verifyExisting(raw: Database.Database, tenant: string, now: number): { job: boolean; present: Set<string> } {
  const bad = (what: string): never => { throw new FixtureRefused('existing_fixture_conflict', what) }
  const job = raw.prepare('SELECT * FROM scan_jobs WHERE id = ?').get(JOB_ID) as Row | undefined
  const present = new Set<string>()
  if (!job) {
    for (const l of fixtureLeads(now)) if (raw.prepare('SELECT 1 FROM leads WHERE id = ?').get(l.id)) bad(`lead ${l.id} exists but the fixture job does not`)
    return { job: false, present }
  }
  if (job.user_id !== tenant) throw new FixtureRefused('job_owned_by_other_tenant', 'the fixture job id already belongs to a different user')
  const want: Row = { business_name: `${FIXTURE_TAG} saved run`, industry: '(from request)', location: '-', query: `${FIXTURE_TAG}: fixture run for the date cases (not a real search)`, icp: JSON.stringify(FIXTURE_ICP), icp_inferred: 0, status: 'done', attempts: 1, claimed_at: null, error: null, candidates: 4, verified: 4, needs_review: 0, dropped: 0 }
  for (const [k, v] of Object.entries(want)) if (job[k] !== v) bad(`scan_jobs.${k} is ${JSON.stringify(job[k])}, expected ${JSON.stringify(v)}`)
  const extra = unsetColumnsAtDefault(raw, 'scan_jobs', job, JOB_CHECKED); if (extra) bad(`fixture job was modified: ${extra}`)
  // nothing else may hang off the fixture job: no other lead, and no row in any other table that references it
  const ours = new Set(fixtureLeads(now).map(l => l.id))
  for (const r of raw.prepare('SELECT id FROM leads WHERE scan_job_id = ?').all(JOB_ID) as { id: string }[]) if (!ours.has(r.id)) bad(`unexpected lead ${r.id} on the fixture job`)
  for (const { name } of raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]) {
    if (name === 'leads' || name === 'scan_jobs') continue
    for (const fk of raw.prepare(`PRAGMA foreign_key_list(${name})`).all() as { table: string; from: string }[]) {
      if (fk.table !== 'scan_jobs') continue
      const n = (raw.prepare(`SELECT COUNT(*) AS n FROM "${name}" WHERE "${fk.from}" = ?`).get(JOB_ID) as { n: number }).n
      if (n) bad(`${n} row(s) in ${name} reference the fixture job`)
    }
  }
  for (const l of fixtureLeads(now)) {
    const row = raw.prepare('SELECT * FROM leads WHERE id = ?').get(l.id) as Row | undefined
    if (!row) continue
    const w: Row = { scan_job_id: JOB_ID, name: l.name, company: l.company, contact: l.contact, signal: l.signal, source_url: l.source_url, score: 60, evidence_excerpt: l.evidence_excerpt, date_status: l.date_status, confidence: 80, dedup_key: l.dedup_key, fit: 3, intent: 3, action: 3, why: `${l.signal} (${FIXTURE_TAG})`, signal_kind: 'expansion', source_kind: 'company_site' }
    for (const [k, v] of Object.entries(w)) if (row[k] !== v) bad(`lead ${l.id}: ${k} is ${JSON.stringify(row[k])}, expected ${JSON.stringify(v)}`)
    if (!dateClassOk(l.case, row.event_date, row.date_status, now)) bad(`lead ${l.id}: event date ${JSON.stringify(row.event_date)} is not a ${l.case}-date value`)
    const ex = unsetColumnsAtDefault(raw, 'leads', row, LEAD_CHECKED); if (ex) bad(`lead ${l.id} was modified: ${ex}`)
    present.add(l.id)
  }
  return { job: true, present }
}
export function plan(raw: Database.Database, env: Env, now: number, mode: 'dry-run' | 'apply' = 'dry-run'): Plan {
  checkEnvironment(env)
  const tenant = resolveTenant(raw)
  // a lead id used by a foreign job refuses before anything else is judged
  for (const l of fixtureLeads(now)) { const e = raw.prepare('SELECT scan_job_id FROM leads WHERE id = ?').get(l.id) as { scan_job_id: string } | undefined; if (e && e.scan_job_id !== JOB_ID) throw new FixtureRefused('lead_id_in_use', `lead id ${l.id} belongs to another job`) }
  const ex = verifyExisting(raw, tenant, now)
  const leads = fixtureLeads(now).map(l => ({ id: l.id, case: l.case, exists: ex.present.has(l.id) }))
  // The leads trigger only accepts leads for a RUNNING job, so a job that already exists is never reopened: a partial earlier state is reported, not repaired.
  if (ex.job && leads.some(l => !l.exists)) throw new FixtureRefused('partial_fixture', 'the fixture job exists but some of its leads are missing; this tool never reopens a finished job (review by hand)')
  return { tenant, email: QA_EMAIL, job: { id: JOB_ID, exists: ex.job }, leads, expected: { scan_jobs: ex.job ? 0 : 1, leads: leads.filter(l => !l.exists).length }, mode }
}
export function apply(raw: Database.Database, env: Env, tenantId: string | undefined, now: number, binding?: Binding | 'unbound-test-only'): Plan & { applied: { scan_jobs: number; leads: number } } {
  if (binding !== 'unbound-test-only') checkBinding(raw, binding)
  const p = plan(raw, env, now, 'apply')
  if (!tenantId) throw new FixtureRefused('tenant_id_required', `--tenant-id=${p.tenant} is required to apply`)
  if (tenantId !== p.tenant) throw new FixtureRefused('tenant_id_mismatch', 'the given tenant id is not the QA workspace')
  const applied = { scan_jobs: 0, leads: 0 }
  raw.transaction(() => {
    // re-read inside the transaction so the plan and the write cannot disagree
    if (binding !== 'unbound-test-only') checkBinding(raw, binding)   // transaction-time recheck: the file is still the one that was bound
    const again = plan(raw, env, now, 'apply'); if (again.tenant !== p.tenant) throw new FixtureRefused('tenant_changed', 'tenant changed during apply')
    if (!again.job.exists) {
      // Same lifecycle as the production writer (finishJob): the job is 'running' only INSIDE this transaction (the leads trigger requires it), and is 'done' when the transaction commits. No other
      // connection ever sees a pending or running fixture job, so no runner can claim it.
      applied.scan_jobs += raw.prepare(
        `INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, icp, icp_inferred, status, attempts, claimed_at, created_at)
         VALUES (?, ?, ?, '(from request)', '-', ?, ?, 0, 'running', 1, ?, ?)`)
        .run(JOB_ID, p.tenant, `${FIXTURE_TAG} saved run`.slice(0, 150), `${FIXTURE_TAG}: fixture run for the date cases (not a real search)`, JSON.stringify(FIXTURE_ICP), now - 3600, now - 3600).changes
      for (const l of fixtureLeads(now)) {
        applied.leads += raw.prepare(
          `INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, score, evidence_excerpt, event_date, date_status, retrieved_at, confidence, dedup_key, fit, intent, action, why, signal_kind, source_kind, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 60, ?, ?, ?, ?, 80, ?, 3, 3, 3, ?, 'expansion', 'company_site', ?)`)
          .run(l.id, JOB_ID, l.name, l.company, l.contact, l.signal, l.source_url, l.evidence_excerpt, l.event_date, l.date_status, now - 7200, l.dedup_key, `${l.signal} (${FIXTURE_TAG})`, now - 3600).changes
      }
      raw.prepare("UPDATE scan_jobs SET status = 'done', error = NULL, claimed_at = NULL, candidates = 4, verified = 4, needs_review = 0, dropped = 0, finished_at = ? WHERE id = ? AND status = 'running'").run(now - 60, JOB_ID)
      // All or nothing, asserted INSIDE this transaction: exactly one job and four leads were inserted (a trigger that silently skipped a row, or any other surprise, rolls everything back) and the final
      // rows are exactly the owned fixture, field by field.
      if (applied.scan_jobs !== 1 || applied.leads !== 4) throw new FixtureRefused('unexpected_write_count', `inserted ${applied.scan_jobs} job(s) and ${applied.leads} lead(s), expected exactly 1 and 4; rolled back`)
      const final = verifyExisting(raw, p.tenant, now)
      if (!final.job || final.present.size !== 4) throw new FixtureRefused('final_fixture_incomplete', 'the fixture is not complete after the write; rolled back')
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
    checkDbFile(env.DB_PATH!)
    raw = new Database(env.DB_PATH!, { fileMustExist: true })
    raw.pragma('foreign_keys = ON')
    const now = Math.floor(Date.now() / 1000)
    const binding: Binding = { expect: process.env.DAZL_FIXTURE_DB_IDENTITY ?? '', production: process.env.DAZL_FIXTURE_PROD_DB_IDENTITY ?? null }
    checkBinding(raw, binding)   // dry-run included: the plan is only ever shown for the bound staging file
    console.log(JSON.stringify(doApply ? apply(raw, env, tenantId, now, binding) : plan(raw, env, now), null, 2))
    if (!doApply) console.log('DRY-RUN: nothing was written. Re-run with --apply --tenant-id=<tenant above> after review.')
  } catch (e) { console.error(e instanceof Error ? e.message : e); process.exitCode = e instanceof FixtureRefused ? 3 : 1 } finally { raw?.close() }
}
