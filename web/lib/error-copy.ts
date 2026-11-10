// Shared UI copy for API error codes. Client-safe: no server imports.
// Raw codes like "key_unreadable" must never reach the page - route every
// user-facing API error through knownErrorCopy before falling back.
export const KEY_UNREADABLE_COPY =
  'Your stored AI key could not be read. Re-enter it in Settings.'

export const DRAFT_UNREADABLE_COPY = 'Your AI key worked, but its answer could not be turned into a profile draft, so nothing was filled in. Your key is fine. Fill the profile in by hand, or try reading the site again later.'

export const PROVIDER_FAILED_COPY = 'The AI provider did not return an answer, so nothing was filled in. Your key was not rejected. Try again shortly.'

// Friendly copy for codes that mean the same thing on every surface.
// Returns null for codes a caller phrases in its own context (or unknown
// codes), so the caller keeps its specific fallback.
export function knownErrorCopy(code: unknown): string | null {
  switch (code) {
    case 'scan_active':
      return 'A scan is still running or finishing. Wait for it to end before starting another.'
    case 'key_unreadable':
      return KEY_UNREADABLE_COPY
    case 'key_rejected':
      return 'Your AI key was rejected. Check it in Settings.'
    // The call completed but its answer could not be turned into a profile. Not a key problem: nothing to re-enter.
    case 'draft_unreadable':
      return DRAFT_UNREADABLE_COPY
    case 'provider_failed':
      return PROVIDER_FAILED_COPY
    case 'trial_key_invalid':
      return 'The scan service is having trouble right now. Try again later.'
    case 'invalid_budget':
      return 'The spend limit was not accepted.'
    case 'model_unpriced':
      return 'The AI model configured for this workspace has no price bound, so the read was refused before it ran. Nothing was charged.'
    case 'accounting_pending':
      return 'The cost of an AI call could not be recorded, so paid generation is paused until that record settles. A recent call - possibly this request - may still be billed to your key.'
    case 'spend_unavailable':
      return 'Your spend budget could not be checked just now, so nothing was generated and nothing was charged. Try again shortly.'
    // A money cap, not a rate cap: the route's own message (app/api/scan/icp-from-url), true on every surface.
    case 'spend_limit':
      return 'Your workspace AI spend limit for today or this month is reached, so nothing was generated and nothing was charged.'
    default:
      return null
  }
}

// #917: a scan or estimate refused a profile because part of it would be cut or ignored (`profile_lossy`). Names each field
// and what to do, so the person can fix the open draft and retry; never shows the raw code. Structural type: this file stays
// client-safe (no server imports), and the server's IcpLoss shape satisfies it.
type LossItem = { field: string; kind: string; limit?: number; actual: number | string; index?: number }
export function lossyProfileCopy(j: { message?: unknown; loss?: unknown }): string {
  const loss = Array.isArray(j.loss) ? (j.loss as LossItem[]) : []
  const lines = loss.slice(0, 8).map(l => {
    const where = typeof l.index === 'number' ? `${l.field} item ${l.index + 1}` : l.field
    if (l.kind === 'too_many_items') return `${where}: ${l.actual} entries, the limit is ${l.limit}. Remove ${Number(l.actual) - Number(l.limit)}.`
    if (l.kind === 'too_long' || l.kind === 'item_too_long') return `${where}: ${l.actual} characters, the limit is ${l.limit}. Shorten it.`
    if (l.kind === 'wrong_type') return `${where}: must be a list, got ${l.actual}.`
    if (l.kind === 'item_not_text') return `${where}: must be text, got ${l.actual}.`
    if (l.kind === 'invalid_value') return l.field === 'window_days' ? `window_days: must be a whole number of days from 1 to 365, got ${l.actual}.` : l.field === 'country' ? `country: must be a two-letter country code such as US or GB, got ${l.actual}.` : `${where}: must be a two-letter language code such as en, got ${l.actual}.`
    return `${where}: not accepted.`
  })
  const head = typeof j.message === 'string' && j.message ? j.message : 'Part of this profile would be cut or ignored.'
  return lines.length ? `${head} ${lines.join(' ')}` : head
}
