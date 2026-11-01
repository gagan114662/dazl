// Shared UI copy for API error codes. Client-safe: no server imports.
// Raw codes like "key_unreadable" must never reach the page - route every
// user-facing API error through knownErrorCopy before falling back.
export const KEY_UNREADABLE_COPY =
  'Your stored AI key could not be read. Re-enter it in Settings.'

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
    case 'trial_key_invalid':
      return 'The scan service is having trouble right now. Try again later.'
    case 'invalid_budget':
      return 'The spend limit was not accepted.'
    case 'model_unpriced':
      return 'The AI model configured for this workspace has no price bound, so the read was refused before it ran. Nothing was charged.'
    case 'accounting_pending':
      return 'The cost of an earlier AI call could not be recorded, so paid generation is paused until that record settles. That call may still be billed to your key. No new charge was made for this request.'
    case 'spend_unavailable':
      return 'Your spend budget could not be checked just now, so nothing was generated and nothing was charged. Try again shortly.'
    default:
      return null
  }
}
