// REVIEW-ONLY gate. Configuration records an approval verified outside this module;
// it never creates consent. A key and a local counter are NOT spending authority.
// No provider call is safe to label free merely from the advertised daily allowance.
// Only an explicit approval accepting possible provider charges may pass this gate.
// No grant-writing HTTP endpoint. Do not merge/activate without impact review.
export type GrantEnv = Record<string, string | undefined>
export type ProviderGrantDecision =
  | { allowed: true; maxRequests: number }
  | { allowed: false; reason: 'approval_missing' | 'approval_expired' | 'approval_invalid' }

export function tinyfishGrant(env: GrantEnv, tenantId: string, now: number): ProviderGrantDecision {
  const raw = env.TINYFISH_APPROVED_TENANTS
  if (!raw) return { allowed: false, reason: 'approval_missing' }
  try {
    const grants: unknown = JSON.parse(raw)
    if (!Array.isArray(grants)) return { allowed: false, reason: 'approval_invalid' }
    const matches = grants.filter(g => g && typeof g === 'object' && g.tenantId === tenantId)
    if (matches.length === 0) return { allowed: false, reason: 'approval_missing' }
    if (matches.length !== 1) return { allowed: false, reason: 'approval_invalid' }
    const g = matches[0]
    // This is an approval reference, not a secret and not an invented authorization.
    if (typeof g.approvalRef !== 'string' || !g.approvalRef.trim() || g.acceptsPossibleCharges !== true ||
        !Number.isSafeInteger(g.expiresAt) || !Number.isSafeInteger(g.maxRequests) || g.maxRequests < 1 || g.maxRequests > 1000)
      return { allowed: false, reason: 'approval_invalid' }
    if (g.expiresAt <= now) return { allowed: false, reason: 'approval_expired' }
    return { allowed: true, maxRequests: g.maxRequests }
  } catch { return { allowed: false, reason: 'approval_invalid' } }
}
