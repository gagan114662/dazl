// Tenant-facing rendering of policy-stop and conversion audit values (#417 privacy minimization).
// Internally the conversion kind (signup/activation/payment) is evidence: it stays in
// lifecycle_events, onboarding_enrollments.source and onboarding_audit.detail. Nothing the
// CONTACTING customer can read - lead cards, draft lists, follow-ups, inbox, the autopilot
// activity feed, or a data export - may carry it, so every tenant-readable boundary maps
// legacy/stored values through these helpers. Mapping is read-time only: no stored row is
// rewritten, no audit evidence deleted. Exports additionally list every generalized column in
// redacted_columns so an export never silently claims to be verbatim.

// The generic tenant-visible reason when a conversion stops pending acquisition work.
export const POLICY_STOP = 'policy_stop'

// Stop-reason state columns (sequences.stop_reason, followup_threads.stopped,
// outreach_messages.error): legacy converted_<kind> reads as the generic policy stop.
export function displayStopReason(reason: string | null | undefined): string | null {
  if (reason && reason.startsWith('converted_')) return POLICY_STOP
  return reason ?? null
}

// Audit/detail text (autopilot_audit.detail, onboarding_audit.detail,
// onboarding_enrollments.source): converted_<kind> reads as the generic policy stop and
// conversion:<kind> as the plain 'conversion'. Everything else passes through untouched.
export function displayAuditDetail(detail: string | null | undefined): string | null {
  if (!detail) return detail ?? null
  if (detail.startsWith('converted_')) return POLICY_STOP
  if (/^conversion:(signup|activation|payment)$/.test(detail)) return 'conversion'
  return detail
}
