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
    case 'preview_accounting_blocked':
      return 'A previous AI call’s cost is unresolved, so this profile preview did not run and was not charged. The earlier call may still be billed. Retrying now or raising the limit will not resolve the earlier charge.'
    case 'preview_spend_busy':
      return 'Another AI step is still being accounted for. This profile preview did not run and was not charged. Wait for the other step to finish before trying again.'
    case 'spend_unavailable':
      return 'Your spend budget could not be checked just now, so nothing was generated and nothing was charged. Try again shortly.'
    // A money cap, not a rate cap: the route's own message (app/api/scan/icp-from-url), true on every surface.
    case 'spend_limit':
      return 'Your workspace AI spend limit for today or this month is reached, so nothing was generated and nothing was charged.'
    default:
      return null
  }
}

// #1095: what a refused first search says when its refusal has no panel of its own (POST /api/scan, on onboarding and on
// Leads). The route's own sentence when it sends one, else words for the code, else a plain sentence: never the code
// itself (a new account once saw `trial_unavailable` on its first search). A "message" that is a bare code is not shown.
const CODE = /\b[a-z]+_[a-z_]+\b/
const START_COPY: Record<string, string> = {
  no_api_key: 'Add your AI key in Settings first. A search needs it.',
  trial_unavailable: "The free trial can't run this search. Link Google in Settings for free scans, or add your own AI key.",
  trial_exhausted: 'Your free scans are used up. Add your own AI key in Settings to keep scanning.',
  quota_exceeded: "You have used this month's scans on your plan. Upgrade in Settings.",
  over_budget: 'This search would go over your spending limit, so nothing was started. Lower the search or raise the limit in Settings.',
  budget_unknown: 'Your spend limit could not be read right now, so nothing was started. Try again in a moment.',
  accounting_unsettled: 'The cost of an earlier paid request is still being recorded, so nothing was started. Try again once it is settled.',
  estimate_changed: 'The cost of this search changed since it was shown, so nothing was started. Run it again to see the new estimate.',
  offer_conflict: 'This search names a different offer than your business profile, so nothing was started. Check the offer and run it again.',
  offer_unreadable: 'Your saved offer could not be read just now, so nothing was started. Try again shortly.',
  website_review_stale: 'The website review could not be verified. Read the site again, then run the search. Nothing was started.',
  website_review_unavailable: 'The website review could not be verified. Read the site again, then run the search. Nothing was started.',
}
export function scanStartErrorCopy(j: { error?: unknown; message?: unknown; used?: unknown; limit?: unknown } | null | undefined): string {
  const code = j?.error
  const known = knownErrorCopy(code)
  if (known) return known
  if (code === 'profile_lossy') return lossyProfileCopy(j as { message?: unknown; loss?: unknown })
  const message = typeof j?.message === 'string' ? j.message.trim() : ''
  if (message.length > 15 && !CODE.test(message)) return message
  if (code === 'quota_exceeded' && typeof j?.used === 'number' && typeof j?.limit === 'number') return `You have used ${j.used} of ${j.limit} scans on your plan. Upgrade in Settings.`
  if (typeof code === 'string' && START_COPY[code]) return START_COPY[code]
  // A sentence the route sent in place of a code (carry-exclusion refusals do this) is already words.
  if (typeof code === 'string' && code.includes(' ') && !CODE.test(code)) return code
  return 'The search could not start, and nothing was started. Try again, or change the search.'
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

// #917: the note above a profile preview. A fallback profile (dazl could not infer one) holds only the first part of a
// long request (fallbackCoverage in lib/scan/icp.ts, sent as `coverage` by POST /api/scan/icp): then it must say so,
// show what was left out, and never claim the request's words are all used. Client-safe; the coverage is untrusted JSON.
export type PreviewNote = { text: string; dropped: string | null }
export function profilePreviewNote(inferred: unknown, coverage: unknown): PreviewNote {
  const c = coverage && typeof coverage === 'object' ? coverage as { complete?: unknown; kept_chars?: unknown; request_chars?: unknown; dropped?: unknown } : null
  // a cut request is disclosed whatever made the profile (the funding-stage guard can fall back to the request's words
  // under an inferred profile, lib/scan/icp.ts previewCoverage)
  if (c && c.complete === false && typeof c.dropped === 'string' && c.dropped.trim()) {
    // counts only when both are whole, safe, non-negative character counts with something left out (Number(null) is 0:
    // 'the first 0 of your 388' would contradict the text; -1, 1.5 or 1e21 would be made up)
    const kept = typeof c.kept_chars === 'number' ? c.kept_chars : NaN, total = typeof c.request_chars === 'number' ? c.request_chars : NaN
    const counts = Number.isSafeInteger(kept) && Number.isSafeInteger(total) && kept >= 0 && total > kept ? `Only the first ${kept} of your ${total} characters are in this profile; the last ${total - kept} are not. ` : 'Only the first part of your request is in this profile. '
    const why = inferred === true ? "dazl used your request's own words for this profile, so it uses its first part only." : 'dazl could not infer more from your request, so this profile uses its first part only.'
    return { text: `${why} ${counts}Add what was left out to the fields below (or shorten the request) before you run the scan.`, dropped: c.dropped.trim() }
  }
  // coverage on an inferred profile means its words are the request's own (the funding-stage guard's fallback,
  // lib/scan/icp.ts previewCoverage): never "worked this out" for that
  if (inferred === true && c && c.complete === true) return { text: "dazl used your request's own words for this profile. Add detail below if you like, then run the scan.", dropped: null }
  if (inferred === true) return { text: 'dazl worked this out from your request. Edit anything that is off, then run the scan.', dropped: null }
  // "as they are" only when the coverage says the whole request is in; anything unreadable never claims it (fails closed)
  if (c && c.complete === true) return { text: 'dazl could not infer more, so it will use your words as they are. Add detail below if you like.', dropped: null }
  return { text: 'dazl could not infer more; this profile is built from your request. Check that it covers everything before you run the scan.', dropped: null }
}
