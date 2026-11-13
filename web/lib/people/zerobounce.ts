// #899 decision (Hermes, delegated by Gagan, 2026-11-12): mailbox verification on a FREE tier only, capped at the free allowance,
// never auto-upgraded. ZeroBounce: a documented single-address API (docs: zerobounce.net/docs/email-validation-api-quickstart/
// v2-validate-emails: the endpoint, api_key/email/timeout query parameters and status values below, per those docs as read on
// 2026-11-12, not yet live-checked) and a recurring free monthly allowance (100 checks, no card: per third-party comparisons,
// to be confirmed when the free key is created). A free account has no card on file,
// so the provider itself refuses once the allowance is spent; dazl also stops at the same number first (lib/people/email-pattern.ts
// verifyMonthlyCap). ZeroBounce documents that an "unknown" result never consumes a credit.
//
// Mapping (fail closed: only an explicit 'valid' is deliverable):
//   valid -> deliverable; catch-all -> catch_all (never verified: DECISIONS 2026-10-26); invalid -> undeliverable;
//   unknown -> unknown; spamtrap / abuse / do_not_mail -> refused (dazl will not use the address);
//   an error body (bad key, no credits), a non-200, an unreadable body or any other status -> thrown, which the caller records
//   as 'uncertain' and never as verified.
import type { MailboxVerifier, VerifyAnswer } from './email-pattern.ts'

export const ZEROBOUNCE_URL = 'https://api.zerobounce.net/v2/validate'
// ZeroBounce's own validation timeout (3-60 s; at the limit it answers unknown / greylisted), and our transport abort above it.
export const ZEROBOUNCE_VALIDATE_TIMEOUT_S = 10
const ABORT_MS = 15_000
// The free monthly allowance this adapter is capped at (operator setting EMAIL_VERIFY_MONTHLY_CAP can only lower it).
export const ZEROBOUNCE_FREE_MONTHLY = 100

export class VerifierError extends Error {
  // 'stop': the account answered that it cannot check at all (bad key, no credits left): no further check this run.
  readonly kind: 'stop' | 'failed'
  constructor(kind: 'stop' | 'failed', msg: string) { super(msg); this.kind = kind }
}

export function zeroBounceVerifier(apiKey: string, fetchImpl: typeof fetch = fetch, name = 'zerobounce'): MailboxVerifier {
  return {
    name,
    async verify(address: string, signal?: AbortSignal): Promise<VerifyAnswer> {
      const q = new URLSearchParams({ api_key: apiKey, email: address, ip_address: '', timeout: String(ZEROBOUNCE_VALIDATE_TIMEOUT_S) })
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), ABORT_MS)
      try {
        const r = await fetchImpl(`${ZEROBOUNCE_URL}?${q}`, { method: 'GET', signal: signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal })
        // A rejected key or a rate limit: the account cannot check now, so the run stops (never burns the allowance on throttled calls).
        if (!r.ok) throw new VerifierError(r.status === 401 || r.status === 403 || r.status === 429 ? 'stop' : 'failed', `ZeroBounce returned ${r.status}`)
        let j: Record<string, unknown>
        try { j = await r.json() as Record<string, unknown> } catch { throw new VerifierError('failed', 'ZeroBounce answer unreadable') }
        // A bad key or an account out of credits answers 200 with { error: "..." } and no status.
        if (j && typeof j.error === 'string' && j.status === undefined) throw new VerifierError('stop', `ZeroBounce: ${j.error.slice(0, 120)}`)
        const status = typeof j?.status === 'string' ? j.status : ''
        const sub = typeof j?.sub_status === 'string' && j.sub_status ? ` (${j.sub_status.slice(0, 40)})` : ''
        switch (status) {
          case 'valid': return { outcome: 'deliverable', detail: `zerobounce valid${sub}` }
          case 'catch-all': case 'catch_all': return { outcome: 'catch_all', detail: `zerobounce catch-all${sub}` }
          case 'invalid': return { outcome: 'undeliverable', detail: `zerobounce invalid${sub}` }
          case 'unknown': return { outcome: 'unknown', detail: `zerobounce unknown${sub}` }
          case 'spamtrap': case 'abuse': case 'do_not_mail': return { outcome: 'refused', detail: `zerobounce ${status}${sub}` }
          default: throw new VerifierError('failed', `ZeroBounce status not recognised: ${status.slice(0, 40) || '(none)'}`)
        }
      } finally { clearTimeout(t) }
    },
  }
}

// TEST-ONLY staging fixture (Hermes 2026-11-12: live checks without signing up for any service). Active ONLY when DAZL_ENV=staging
// AND DAZL_STAGING_FAKE_ZEROBOUNCE=1 (email-pattern.ts verifierFromEnv); inert everywhere else, so production can never use it. It
// answers the real adapter's request shape with no network, deterministically from the address's local part: 'invalid' ->
// invalid, 'catchall' -> catch-all, 'unknown' -> unknown, 'spamtrap' -> spamtrap, 'nocredits' -> the out-of-credits error body,
// anything else -> valid. Its checks are recorded under the verifier name 'zerobounce-staging-fake', never as 'zerobounce'.
export const ZEROBOUNCE_STAGING_FAKE = 'zerobounce-staging-fake'
export const zeroBounceStagingFetch = (async (u: RequestInfo | URL) => {
  const email = new URL(String(u)).searchParams.get('email') ?? ''
  const local = email.split('@')[0].toLowerCase()
  const body = local.includes('nocredits') ? { error: 'Invalid API key or your account ran out of credits' }
    : { address: email, status: local.includes('invalid') ? 'invalid' : local.includes('catchall') ? 'catch-all' : local.includes('unknown') ? 'unknown' : local.includes('spamtrap') ? 'spamtrap' : 'valid', sub_status: '' }
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}) as typeof fetch
