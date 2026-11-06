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

// Result message for the panel's POST actions. A sync that the server refused (sync.error) is never "Checked replies".
export function actionMessage(action: string, ok: boolean, body: unknown): string {
  const j = (body && typeof body === 'object' ? body : {}) as { error?: unknown; sync?: { error?: unknown } }
  if (!ok) return typeof j.error === 'string' && j.error ? j.error : 'Something went wrong'
  if (action !== 'sync') return ''
  const err = j.sync && typeof j.sync === 'object' ? j.sync.error : undefined
  if (err === 'reading_not_enabled') return 'Replies were not checked: reply reading is off.'
  if (err === 'gmail_unavailable') return 'Replies were not checked: Gmail could not be reached. Try again, or reconnect Gmail.'
  if (err) return 'Replies were not checked. Try again later.'
  return 'Checked replies.'
}
