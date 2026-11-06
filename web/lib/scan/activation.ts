// #409: time-to-value and drop-off of the website-first onboarding journey (sign up -> read your website -> review and
// save the offer -> first scan -> first verified lead), measured from durable rows only. Nothing here is estimated or
// back-filled: a stage with no row is "not reached", and a store that cannot be read is "unknown", never a drop-off.
//
// Where each stage comes from:
//   - signed up: the workspace's organizations row (created_at; the founder's users row when there is none);
//   - read the website: an `onboarding.site_read` audit event (lib/audit.ts), written by POST /api/scan/icp-from-url
//     for every read past the route's own rate limit, with the path it took (own key, free trial, free facts-only read, or
//     none when it stopped before the fetch), its result (a drafted profile, the page's own facts, or an error) and the
//     refusal or error reason;
//   - saved the offer: the first `settings.changed` audit event on the profile (POST /api/settings/profile, the only
//     place a reviewed offer is saved);
//   - first scan: the workspace's first scan_jobs row;
//   - first verified lead: the first lead that passed the verifier and is not held, in review, rejected or graded not a
//     fit - the first checks of the Home journey's opportunity test (lib/journey.ts heldReason). The Home test's later
//     checks (date, time window, company website) are computed per read and are not re-derived here.
// Time-to-value is first verified lead minus sign-up, in seconds; a negative span (clock skew, an imported row) is
// reported as unknown, never as a fast activation.
import type { Db } from '../db/client.ts'
import { captureError } from '../ops/errors.ts'

export const SITE_READ_ACTION = 'onboarding.site_read'
export const STAGES = ['signed_up', 'read_site', 'saved_offer', 'started_scan', 'verified_lead'] as const
export type Stage = typeof STAGES[number]
// 'none': the read stopped before the page was fetched (a bad address, saved targeting that could not be read).
export type SiteReadPath = 'own_key' | 'trial' | 'free' | 'none'
export type SiteReadResult = 'profile' | 'facts' | 'error'
export interface SiteReadOutcome { path: SiteReadPath; result: SiteReadResult; reason: string | null }

// A reason is a short snake_case code (a refusal of lib/scan/trial-site-read.ts or an error of lib/scan/icp-from-site.ts);
// anything else is recorded as 'unknown', so a malformed value can never smuggle text into the audit trail.
const code = (v: unknown): string | null => (typeof v === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(v) ? v : v === undefined || v === null ? null : 'unknown')

// What one website read did, from the route's own answer (icpFromWebsite's result). Total: any shape maps to an outcome.
export function siteReadOutcome(out: unknown, o: { keyed: boolean; ineligible?: boolean }): SiteReadOutcome {
  const r = out && typeof out === 'object' && !Array.isArray(out) ? out as Record<string, unknown> : null
  if (!r) return { path: o.keyed ? 'own_key' : 'free', result: 'error', reason: 'unknown' }
  if ('error' in r) return { path: o.keyed ? 'own_key' : 'free', result: 'error', reason: code(r.error) ?? 'unknown' }
  if (r.free === true) return { path: 'free', result: 'facts', reason: code(r.trial) ?? (o.ineligible ? 'workspace_not_eligible' : o.keyed ? 'unknown' : 'not_configured') }
  if (r.icp && typeof r.icp === 'object') return { path: r.funded === 'trial' ? 'trial' : r.funded === 'own' || o.keyed ? 'own_key' : 'trial', result: 'profile', reason: null }
  return { path: o.keyed ? 'own_key' : 'free', result: 'error', reason: 'unknown' }
}

export interface Activation {
  tenant: string
  // Seconds since the epoch at which each stage was first reached; null = not reached.
  at: Record<Stage, number | null>
  // The first stage not reached (the drop-off), or null when every stage was reached.
  dropped_at: Stage | null
  ttv_s: number | null
  // The first and the last website read: which path and result, and why (a refusal or an error).
  first_read: SiteReadOutcome | null
  last_read: SiteReadOutcome | null
  reads: number
}
export type ActivationRead = Activation | { tenant: string; unknown: true; where: string }

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' && /^\d{1,12}$/.test(v) ? Number(v) : v
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null
}
function parseRead(summary: unknown): SiteReadOutcome {
  let s: unknown = summary
  if (typeof s === 'string') { try { s = JSON.parse(s) } catch { s = null } }
  const r = s && typeof s === 'object' && !Array.isArray(s) ? s as Record<string, unknown> : {}
  const path = r.path === 'own_key' || r.path === 'trial' || r.path === 'free' || r.path === 'none' ? r.path : null
  const result = r.result === 'profile' || r.result === 'facts' || r.result === 'error' ? r.result : null
  if (!path || !result) return { path: path ?? 'free', result: 'error', reason: 'unreadable' }
  return { path, result, reason: code(r.reason) }
}

// Pure: the stages from their first timestamps. A later stage with no earlier one (a scan without a saved offer, say)
// still counts as reached; the drop-off is the FIRST stage that has no row.
export function activationOf(tenant: string, at: Record<Stage, number | null>, reads: SiteReadOutcome[] = []): Activation {
  const dropped_at = STAGES.find(s => at[s] === null) ?? null
  const span = at.signed_up !== null && at.verified_lead !== null ? at.verified_lead - at.signed_up : null
  return { tenant, at, dropped_at, ttv_s: span !== null && span >= 0 ? span : null, first_read: reads[0] ?? null, last_read: reads.at(-1) ?? null, reads: reads.length }
}

const VERIFIED = `SELECT min(l.created_at) AS t FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id
  WHERE j.user_id = ? AND l.confidence IS NOT NULL AND l.review_reason IS NULL AND l.quarantined_at IS NULL AND NOT (coalesce(l.fit, -1) = 0 AND l.intent IS NULL)
    AND NOT EXISTS (SELECT 1 FROM lead_enrichments h WHERE h.lead_id = l.id AND h.connector = 'scan:gate' AND h.kind = 'gate_failed')`

// One workspace's journey. app: the store holding organizations, users and audit_events (getDb()); scan: the store
// holding scan_jobs and leads (the same one unless scans still run on SQLite while the app reads Postgres). Any read
// that fails makes the whole answer unknown (and is reported), never a partial journey that would read as a drop-off.
export async function readActivation(app: Db, scan: Db, tenant: string): Promise<ActivationRead> {
  if (typeof tenant !== 'string' || !tenant || tenant.length > 80) return { tenant: String(tenant).slice(0, 80), unknown: true, where: 'tenant' }
  let where = 'signup'
  try {
    const org = await app.get<{ t: unknown }>('SELECT created_at AS t FROM organizations WHERE id = ?', [tenant])
    const signed = num(org?.t) ?? num((await app.get<{ t: unknown }>('SELECT created_at AS t FROM users WHERE id = ?', [tenant]))?.t)
    where = 'audit'
    const reads = await app.all<{ at: unknown; summary: unknown }>('SELECT at, summary FROM audit_events WHERE tenant_id = ? AND action = ? ORDER BY at, seq, id', [tenant, SITE_READ_ACTION])
    const offer = await app.get<{ t: unknown }>("SELECT min(at) AS t FROM audit_events WHERE tenant_id = ? AND action = 'settings.changed' AND resource_type = 'profile'", [tenant])
    where = 'scans'
    const scanAt = await scan.get<{ t: unknown }>('SELECT min(created_at) AS t FROM scan_jobs WHERE user_id = ?', [tenant])
    where = 'leads'
    const lead = await scan.get<{ t: unknown }>(VERIFIED, [tenant])
    return activationOf(tenant, {
      signed_up: signed, read_site: num(reads[0]?.at), saved_offer: num(offer?.t), started_scan: num(scanAt?.t), verified_lead: num(lead?.t),
    }, reads.map(r => parseRead(r.summary)))
  } catch (e) {
    captureError(e, { source: 'process', where: `activation:${where}`, tenantId: tenant })
    return { tenant, unknown: true, where }
  }
}

export interface ActivationReport {
  since: number; until: number; workspaces: number; truncated: boolean; unknown: number
  reached: Record<Stage, number>
  dropped_at: Record<Stage, number>
  ttv_s: { n: number; median: number | null; p90: number | null }
  // How the first website read went, by path/result/reason (e.g. "free/facts/not_in_allowlist": 4).
  first_read: Record<string, number>
}
export const REPORT_MAX = 5000

const pct = (sorted: number[], p: number): number | null => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] : null)

// Pure: the deployment's funnel from per-workspace journeys. An unknown journey is counted apart, never as a drop-off.
export function summarize(rows: ActivationRead[], since: number, until: number, truncated = false): ActivationReport {
  const zero = () => Object.fromEntries(STAGES.map(s => [s, 0])) as Record<Stage, number>
  const out: ActivationReport = { since, until, workspaces: rows.length, truncated, unknown: 0, reached: zero(), dropped_at: zero(), ttv_s: { n: 0, median: null, p90: null }, first_read: {} }
  const ttv: number[] = []
  for (const r of rows) {
    if ('unknown' in r) { out.unknown++; continue }
    for (const s of STAGES) if (r.at[s] !== null) out.reached[s]++
    if (r.dropped_at) out.dropped_at[r.dropped_at]++
    if (r.ttv_s !== null) ttv.push(r.ttv_s)
    if (r.first_read) { const k = `${r.first_read.path}/${r.first_read.result}/${r.first_read.reason ?? '-'}`; out.first_read[k] = (out.first_read[k] ?? 0) + 1 }
  }
  ttv.sort((a, b) => a - b)
  out.ttv_s = { n: ttv.length, median: pct(ttv, 0.5), p90: pct(ttv, 0.9) }
  return out
}

// Every workspace created in [since, until), oldest first, at most REPORT_MAX (truncated says so). Read-only.
export async function activationReport(app: Db, scan: Db, o: { since: number; until: number }): Promise<ActivationReport> {
  if (!Number.isInteger(o.since) || !Number.isInteger(o.until) || o.since < 0 || o.until <= o.since) throw new RangeError('activationReport: since/until must be integer seconds with since < until')
  const ids = await app.all<{ id: string }>('SELECT id FROM organizations WHERE created_at >= ? AND created_at < ? ORDER BY created_at, id LIMIT ?', [o.since, o.until, REPORT_MAX + 1])
  const rows: ActivationRead[] = []
  for (const { id } of ids.slice(0, REPORT_MAX)) rows.push(await readActivation(app, scan, id))
  return summarize(rows, o.since, o.until, ids.length > REPORT_MAX)
}

export function formatActivation(r: ActivationReport): string {
  const day = (s: number) => new Date(s * 1000).toISOString().slice(0, 10)
  const dur = (s: number | null) => (s === null ? 'n/a' : s < 3600 ? `${Math.round(s / 60)} min` : s < 172800 ? `${(s / 3600).toFixed(1)} h` : `${(s / 86400).toFixed(1)} d`)
  const lines = [`Onboarding activation, workspaces created ${day(r.since)} .. ${day(r.until)}: ${r.workspaces}${r.truncated ? ` (first ${REPORT_MAX} only)` : ''}${r.unknown ? `, ${r.unknown} unreadable (not counted below)` : ''}`]
  for (const s of STAGES) lines.push(`  ${s.padEnd(14)} reached ${String(r.reached[s]).padStart(5)}   stopped here ${String(r.dropped_at[s]).padStart(5)}`)
  lines.push(`  time to first verified lead: median ${dur(r.ttv_s.median)}, p90 ${dur(r.ttv_s.p90)} (n=${r.ttv_s.n})`)
  for (const [k, n] of Object.entries(r.first_read).sort((a, b) => b[1] - a[1])) lines.push(`  first website read ${k}: ${n}`)
  return lines.join('\n')
}
