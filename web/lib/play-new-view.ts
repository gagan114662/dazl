// #1042: the Plays page's pure pieces for "Find leads now" and "new since you last checked". Display-only; the run and
// the new-lead list come from POST /api/plays/[kind]/[id]/run and GET /api/plays/[kind]/[id]/new (lib/play-now.ts).
//
// "Last checked" is kept per play in this browser (localStorage), as the newest run time the person has marked as seen.
// Decision (Hermes, under delegation, reversible): no new table or migration for a per-device read marker; a new device
// shows the play's new leads once more. Anything unreadable in storage reads as "never checked" (0), never as a time
// in the future that would hide new leads.
import { whenOf } from './saved-plays.ts'

export const seenKey = (kind: string, id: string) => `dazl:play-seen:${kind}:${id}`

export function parseSeen(raw: unknown, now = Math.floor(Date.now() / 1000)): number {
  if (typeof raw !== 'string' || !/^\d{1,12}$/.test(raw)) return 0
  const n = Number(raw)
  return Number.isSafeInteger(n) && n <= now + 86400 ? n : 0
}

export interface StorageLike { getItem(k: string): string | null; setItem(k: string, v: string): void }
export function readSeen(store: StorageLike | null | undefined, kind: string, id: string, now?: number): number {
  try { return parseSeen(store?.getItem(seenKey(kind, id)) ?? null, now) } catch { return 0 }
}
// Never moves the marker backwards (a stale tab cannot bring back leads already marked as seen). Callers pass the newest
// run time of the list they displayed, so nothing found after it is marked as seen.
export function writeSeen(store: StorageLike | null | undefined, kind: string, id: string, at: number): boolean {
  if (!Number.isSafeInteger(at) || at <= 0) return false
  try {
    // a stored value readSeen would ignore (malformed, or in the future) never blocks a fresh marker
    if (parseSeen(store?.getItem(seenKey(kind, id)) ?? null) >= at) return false
    store?.setItem(seenKey(kind, id), String(at)); return !!store
  } catch { return false }
}

export const newLabel = (n: number, everChecked: boolean) =>
  n <= 0 ? (everChecked ? 'Nothing new since you last checked' : 'No new leads yet')
    : `${n} new ${n === 1 ? 'lead' : 'leads'} ${everChecked ? 'since you last checked' : 'so far'}`

// After Find leads now, the page follows the started run with the read-only status read (GET /api/scan/status?readonly=1)
// every RUN_POLL_MS, at most RUN_POLL_MAX times (20 minutes), and reloads the play and its new leads once the run has
// ended. Anything unreadable keeps polling until the bound; a run that is gone (404) ends the poll.
export const RUN_POLL_MS = 5000
export const RUN_POLL_MAX = 240
export function runEnded(httpStatus: number, body: unknown): boolean {
  if (httpStatus === 404) return true
  const s = body && typeof body === 'object' ? (body as { status?: unknown }).status : undefined
  return s === 'done' || s === 'failed'
}

export type RunNowAnswer = { job_id: string; next_run_at: number; funded_by?: 'user' | 'trial' } | { error: string; retry_at?: number } | null
// What the person sees after pressing Find leads now: one sentence, never a raw code.
export function runNowMessage(status: number, body: RunNowAnswer, timeZone?: string): { ok: boolean; text: string } {
  if (body && 'job_id' in body && status === 202) return { ok: true, text: `Started${body.funded_by === 'trial' ? ' on your free searches' : ''}. The new leads show here when this run finishes. Its next scheduled run moved to ${whenOf(body.next_run_at, timeZone)}.` }
  const e = body && 'error' in body ? body.error : ''
  switch (e) {
    case 'paused': return { ok: false, text: 'This play is paused. Resume it to run it.' }
    case 'no_api_key': return { ok: false, text: 'Running a play on demand uses your own AI key. Add one in Settings, or run a one-off search in Leads.' }
    case 'trial_used': return { ok: false, text: 'Your free searches are used up. Add your own AI key in Settings to keep this play running.' }
    case 'trial_busy': return { ok: false, text: "Today's free searches are all taken. Try again tomorrow, or add your own AI key in Settings." }
    case 'daily_cap': return { ok: false, text: `The free plan runs this play once a day and a search already ran today. It can run again after ${body && 'retry_at' in body && typeof body.retry_at === 'number' ? whenOf(body.retry_at, timeZone) : 'midnight UTC'}.` }
    case 'runner_unavailable': return { ok: false, text: "Plays can't be run on demand right now. Its scheduled run still happens." }
    case 'quota_exceeded': return { ok: false, text: "This month's scans are used up, so it can't run now." }
    case 'scan_active': return { ok: false, text: 'A scan is already running or finishing. Try again when it ends.' }
    case 'too_soon': return { ok: false, text: body && 'retry_at' in body && typeof body.retry_at === 'number' ? `This play just ran. You can run it again after ${whenOf(body.retry_at, timeZone)}.` : 'This play just ran. Try again in an hour.' }
    case 'not_found': return { ok: false, text: 'This play no longer exists. Refresh the page.' }
    case 'too_many': return { ok: false, text: 'Too many runs started in the last hour. Try again later.' }
    default: return { ok: false, text: 'Could not start this play. Try again.' }
  }
}
