// #1042: after each run of a saved play (weekly, or the first play's daily repeat), one short email to the account listing the new leads that run found.
// Owner scope (Gagan via Quest, 2026-11-11 11:48): "after each scheduled run, send an email listing the new leads found".
//
// Which runs: a finished ('done') run of a LIVE weekly play (lib/watch.ts), started after the play was saved (so the
// first play's own run, which its automatic repeat links, never mails), that finished within MAIL_WINDOW_S. A run whose
// enrichment is still going waits for it (up to ENRICH_STALE_S, as lib/monitors.ts does), so the list is the one the
// Leads page shows. A play that is paused (or deleted) when its run is picked up mails nothing for that run, and
// resuming it later does not send it late: pausing stops the runs and the emails. A run with no new leads mails nothing.
// Which leads: the run's leads this play had never surfaced before (leads.watch_new, lib/watch.ts), visible the way
// the Leads list shows them (not quarantined, not the low-fit tier: lib/scan/store-db.ts), best first; at most
// MAIL_LIST_MAX are listed, with the count of the rest and a link to the run in Leads.
// #883, once per company across plays: before the list is read, the run claims each of those leads in the tenant's
// alert record (lib/watch.ts claimWatchAlertsStep, the step the scan runner already took when the run's results became
// final; repeated here so a run whose worker died before that step is still claimed). A company another play's run
// already alerted is not new, so it is not listed and not counted; a run left with nothing new mails nothing. A run
// that will never be mailed (paused play, no confirmed address) releases what it holds.
// To whom: the account's own verified address (the founder of the workspace; never an unverified address).
// Once only, across ticks, instances and crashes: the run is claimed in the same transaction that reads it, by a
// reserved row in the play's own memory (watch_seen 'mail:<job id>'; a company key is a domain or [a-z0-9] name and
// never contains ':'). The claim commits before the send, so a crash or a send failure can lose one email but never
// send two. Decision (Hermes, under delegation, reversible): no new table/migration for this marker; a dedicated table
// can replace it.
// Delivery is lib/system-mail.ts: SMTP when the host has it configured, otherwise the message stays in the host's
// outbox (and tests read it there). Nothing is sent to any lead or prospect; this mail goes only to the account.
import type { Db, Tx, TxBody } from './db/client.ts'
import { claimWatchAlertsStep, type Fence } from './watch.ts'
import { lockAlertsStep, releaseRunAlertsStep, VISIBLE_LEAD } from './play-alerts.ts'
import { sendSystemMail } from './system-mail.ts'
import { ENRICH_STALE_S } from './scan/enrichment.ts'
import { playName, type PlayIcp } from './play-card.ts'
import { LeaseLost, StaleLeaseWrite } from './shared/lease.ts'
import { captureError } from './ops/errors.ts'
import { isFirstPlayRepeatStep } from './play-funding.ts'

export const MAIL_WINDOW_S = 86400
export const MAIL_LIST_MAX = 10
const BATCH = 200
const nowS = () => Math.floor(Date.now() / 1000)
const noFence: Fence = function* () { /* not fenced */ }
export const mailClaimKey = (jobId: string) => `mail:${jobId}`

export { VISIBLE_LEAD }
const DUE_SQL = `SELECT j.id AS job_id, j.user_id, w.id AS watch_id, j.finished_at FROM scan_jobs j JOIN watches w ON w.id = j.watch_id AND w.user_id = j.user_id
  WHERE j.status = 'done' AND j.created_at >= w.created_at AND j.finished_at >= ?
    AND (j.enrich_finished_at IS NOT NULL OR COALESCE(j.enrich_started_at, j.finished_at, 0) <= ?)
    AND NOT EXISTS (SELECT 1 FROM watch_seen s WHERE s.watch_id = w.id AND s.seen_key = 'mail:' || j.id)
  ORDER BY j.finished_at, j.id LIMIT ${BATCH}`
const NEW_LEADS_SQL = `SELECT l.company, l.signal FROM leads l WHERE l.scan_job_id = ? AND l.watch_new = 1 AND ${VISIBLE_LEAD} ORDER BY l.score DESC, l.id LIMIT ?`
const NEW_COUNT_SQL = `SELECT count(*) AS n FROM leads l WHERE l.scan_job_id = ? AND l.watch_new = 1 AND ${VISIBLE_LEAD}`
// the workspace's founder (a personal workspace's id is its founder's user id), verified addresses only
const TO_SQL = `SELECT u.email FROM users u WHERE u.email_verified_at IS NOT NULL AND u.id = COALESCE((SELECT o.created_by FROM organizations o WHERE o.id = ?), ?)`

type Due = { job_id: string; user_id: string; watch_id: string; finished_at: number }
export interface PlayRunMail { userId: string; to: string; subject: string; text: string }

// One line of text: control characters (a header break included) become spaces; lone surrogates are made well-formed.
export function oneLine(v: unknown, max: number): string {
  const s = typeof v === 'string' ? v : v == null ? '' : String(v)
  const clean = (s.toWellFormed ? s.toWellFormed() : s).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean
}
const asIcp = (raw: string | null): PlayIcp | null => { try { const v = raw ? JSON.parse(raw) : null; return v && typeof v === 'object' && !Array.isArray(v) ? v as PlayIcp : null } catch { return null } }

// daily: the play is the first play's automatic repeat, which runs every day (lib/play-cadence.ts); otherwise weekly
export function composePlayRunMail(o: { userId: string; to: string; jobId: string; query: string; icp: string | null; total: number; leads: { company: unknown; signal: unknown }[]; base: string; daily?: boolean }): PlayRunMail {
  const name = oneLine(playName(o.query, asIcp(o.icp)), 80) || 'your play'
  const n = o.total, s = n === 1 ? '' : 's'
  const lines = o.leads.slice(0, MAIL_LIST_MAX).map(l => {
    const company = oneLine(l.company, 120) || 'A company', why = oneLine(l.signal, 200)
    return `- ${company}${why ? `: ${why}` : ''}`
  })
  const more = n - lines.length
  const base = o.base.replace(/\/+$/, '')
  const text = [
    `Your play "${name}" ran again and found ${n} new lead${s} you have not been shown before:`, '',
    ...lines, ...(more > 0 ? [`...and ${more} more.`] : []), '',
    `See them in Leads: ${base}/app/leads?job_id=${o.jobId}`,
    `Your plays: ${base}/app/plays`, '',
    `This play runs again every ${o.daily ? 'day' : 'week'}. To stop its runs and these emails, pause it on the Plays page.`,
    'Nothing was sent to anyone on your behalf.',
  ].join('\n')
  return { userId: o.userId, to: o.to, subject: `${n} new lead${s} from your play "${name}"`, text }
}

function* claimRun(t: Tx, d: Due, fence: Fence, base: string, now: number): TxBody<PlayRunMail | null> {
  yield* fence(t)
  const claim = yield* t.run('INSERT INTO watch_seen (watch_id, seen_key) VALUES (?, ?) ON CONFLICT (watch_id, seen_key) DO NOTHING', [d.watch_id, mailClaimKey(d.job_id)])
  if (claim.changes !== 1) return null // another tick or instance has it
  // read under the claim: a play paused or deleted since the list was read mails nothing (the claim stays: once only)
  const w = yield* t.get<{ query: string; icp: string | null; active: number }>('SELECT query, icp, active FROM watches WHERE id = ? AND user_id = ?', [d.watch_id, d.user_id])
  const to = (yield* t.get<{ email: string }>(TO_SQL, [d.user_id, d.user_id]))?.email
  if (!w || Number(w.active) !== 1 || typeof to !== 'string' || !to.includes('@') || /[\r\n]/.test(to)) {
    // #883: this run will never be mailed, so it gives up the companies it holds: another play still mails them
    yield* lockAlertsStep(t, d.user_id)
    yield* releaseRunAlertsStep(t, d.user_id, d.job_id)
    return null
  }
  yield* claimWatchAlertsStep(t, d.watch_id, d.job_id, now) // #883: a company another play already alerted leaves the list
  const total = Number((yield* t.get<{ n: number }>(NEW_COUNT_SQL, [d.job_id]))?.n ?? 0)
  if (!(total > 0)) return null
  const leads = yield* t.all<{ company: unknown; signal: unknown }>(NEW_LEADS_SQL, [d.job_id, MAIL_LIST_MAX])
  const daily = yield* isFirstPlayRepeatStep(t, d.user_id, d.watch_id)
  return composePlayRunMail({ userId: d.user_id, to, jobId: d.job_id, query: w.query, icp: w.icp, total, leads, base, daily })
}

// Returns how many emails went out (or into the outbox). One run's failure is recorded and skipped; a lost lease stops
// the whole pass before anything else is claimed.
export async function sendPlayRunMails(db: Db, o: { now?: number; fence?: Fence; env?: Record<string, string | undefined> } = {}): Promise<number> {
  const now = o.now ?? nowS(), fence = o.fence ?? noFence, env = o.env ?? process.env
  const base = env.PUBLIC_BASE_URL || 'https://dazl.ai'
  const due = await db.all<Due>(DUE_SQL, [now - MAIL_WINDOW_S, now - ENRICH_STALE_S])
  let sent = 0
  for (const d of due) {
    let mail: PlayRunMail | null = null
    try { mail = await db.tx(t => claimRun(t, d, fence, base, now)) } catch (e) {
      if (e instanceof LeaseLost || e instanceof StaleLeaseWrite) throw e
      captureError(e, { source: 'worker', where: 'play-mail:claim', tenantId: d.user_id }); continue
    }
    if (!mail) continue
    try { await sendSystemMail(db, mail, env); sent++ } catch (e) { captureError(e, { source: 'worker', where: 'play-mail:send', tenantId: d.user_id }) }
  }
  return sent
}
