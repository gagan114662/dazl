// Browser-safe view logic for the Settings "Replies and follow-ups" panel (#931).
// Reply reading is ON only when all three hold: an active Gmail connection, the provider read scope, and accepted
// current-version app consent. Revoking app consent leaves the Gmail read scope granted, so the panel must not treat
// read_granted alone as "on" and must offer re-acceptance without a reconnect.

export type GmailStatus = 'none' | 'active' | 'needs_reconnect'

export interface RepliesViewInput {
  gmail_status?: GmailStatus
  gmail_connected: boolean
  read_granted: boolean
  consent: { accepted: boolean }
}

export type ReplyReadingState = 'disconnected' | 'needs_reconnect' | 'read_scope_missing' | 'consent_needed' | 'on'

export function replyReadingState(i: RepliesViewInput): ReplyReadingState {
  const status: GmailStatus = i.gmail_status ?? (i.gmail_connected ? 'active' : 'none')
  if (status === 'none') return 'disconnected'
  if (status !== 'active') return 'needs_reconnect'
  if (!i.read_granted) return 'read_scope_missing'
  if (!i.consent.accepted) return 'consent_needed'
  return 'on'
}

export const CONSENT_NEEDED_NOTICE = 'Reading replies: off. Reply reading was turned off, so dazl is not reading replies or sending follow-ups. Gmail stays connected; accept the current terms below to turn it back on.'

// A usable sync result, as syncReplies returns it: every count a non-negative integer, optional fields typed. A body that
// is missing, null, {}, {ok:false} or {ok:true, sync:null} was never an observed sync, so it is never "Checked replies".
const COUNTS = ['threads', 'replies', 'optOuts', 'bounces', 'consents', 'reviews'] as const
const isCount = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0
export function isSyncResult(v: unknown): v is { threads: number; replies: number; optOuts: number; bounces: number; consents: number; reviews: number; error?: string } {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const o = v as Record<string, unknown>
  if (!COUNTS.every(k => isCount(o[k]))) return false
  for (const k of ['remaining', 'neverRead', 'freshAsOf']) if (o[k] !== undefined && !isCount(o[k])) return false
  return o.error === undefined || typeof o.error === 'string'
}
export const SYNC_NOT_CONFIRMED = 'Replies were not confirmed checked: dazl did not get a usable result. Check the status above and try again later.'

// Result message for the panel's POST actions. A sync that the server refused (sync.error) is never "Checked replies", and
// neither is a 2xx whose body does not carry a valid sync result.
export function actionMessage(action: string, ok: boolean, body: unknown): string {
  const j = (body && typeof body === 'object' ? body : {}) as { error?: unknown; ok?: unknown; sync?: unknown }
  if (!ok) return typeof j.error === 'string' && j.error ? j.error : 'Something went wrong'
  if (action !== 'sync') return ''
  // A refusal the server named is reported as that refusal even if its counts are missing; anything else needs a valid result.
  const named = j.sync && typeof j.sync === 'object' && !Array.isArray(j.sync) && typeof (j.sync as { error?: unknown }).error === 'string' && (j.sync as { error: string }).error ? (j.sync as { error: string }).error : undefined
  if (!named && (j.ok !== true || !isSyncResult(j.sync))) return SYNC_NOT_CONFIRMED
  const err = named
  if (err === 'reading_not_enabled') return 'Replies were not checked: reply reading is off.'
  if (err === 'gmail_unavailable') return 'Replies were not checked: Gmail could not be reached. Try again, or reconnect Gmail.'
  if (err) return 'Replies were not checked. Try again later.'
  return 'Checked replies.'
}

// One panel action: a single POST, never retried. A rejected request (offline, aborted) or an unreadable body becomes a
// visible message instead of an unhandled rejection; the caller reloads the real state afterwards either way.
export const ACTION_UNCONFIRMED = 'Could not reach dazl, so this was not confirmed. The status shown is reloaded from the server; check it before trying again.'
export async function performReplyAction(fetchImpl: typeof fetch, action: string, version?: string): Promise<{ message: string; reached: boolean }> {
  let r: Response
  try { r = await fetchImpl('/api/outreach/replies', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, accept: true, version }) }) }
  catch { return { message: action === 'sync' ? SYNC_NOT_CONFIRMED : ACTION_UNCONFIRMED, reached: false } }
  const body = await r.json().catch(() => ({}))
  return { message: actionMessage(action, r.ok, body), reached: true }
}
