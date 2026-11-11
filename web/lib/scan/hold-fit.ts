// Does a lead's stored hold reason apply to its saved claim? (#684, part of #352). Pure and client-safe.
//
// One known contradiction: a customer-mention hold (counterparty_signal - "another company's page names it as their customer")
// on a claim that is a job posting. A job ad is the employer's own statement wherever it is posted (a job board, an ATS), so
// "someone else's customer" can never be the reason it is held. Before #684 the check fired on job board pages ("Apply using
// DentalPost"), so stored rows can carry that reason beside a vacancy claim.
//
// This changes TEXT only. The stored reason, the draft gate (currentnessHeld), the research classification and the contact
// search all keep reading the stored code, so such a row stays held and research only - it is just not described with a reason
// that contradicts its claim. Malformed input never counts as a job posting, so it never changes what is shown.
import { isHiringTrigger } from './scoreboard.ts'

const HIRING_KINDS = new Set(['hiring', 'hiring_relevant_role'])
const MAX_SIGNAL = 2000 // a claim is a short sentence; anything longer is not read as a job posting

// A claim that is a job posting, on positive string evidence only: a hiring signal, a hiring signal kind, or the public
// job-posting feed. Wrong types (number, object, array, null) are not a job posting.
export function isJobPostingClaim(c: { signal?: unknown; signal_kind?: unknown; source_kind?: unknown } | null | undefined): boolean {
  if (!c || typeof c !== 'object') return false
  if (typeof c.signal_kind === 'string' && HIRING_KINDS.has(c.signal_kind)) return true
  if (c.source_kind === 'hiring_feed') return true
  return typeof c.signal === 'string' && c.signal.length <= MAX_SIGNAL && isHiringTrigger(c.signal, null)
}

// false only when the stored reason cannot apply to this saved claim; any other input (unknown or malformed reason or claim)
// is shown as stored.
export function holdFitsClaim(reason: unknown, claim: { signal?: unknown; signal_kind?: unknown; source_kind?: unknown } | null | undefined): boolean {
  if (reason === 'counterparty_signal' && isJobPostingClaim(claim)) return false
  return true
}

// What the Leads view shows instead of the customer label for such a row. It stays held: research only, out of drafting.
export const MISFIT_LABEL = 'Not verified - it was held by the check for another company\'s page, which does not apply to a job posting, so dazl has not verified this claim. It stays out of drafting'
