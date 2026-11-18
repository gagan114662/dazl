// Synthetic price response: intentionally above the configured trial cap before UI formatting.
export const onboardingEstimate = {
  ack: 'onboarding-fixture-ack', payer: 'trial', trial_scan_cap_usd: 0.3,
  rows: [], assumptions: [], unpriced: [], total: { min: 0.09, max: 0.66 },
  cap: { max_usd: null, month_cap_usd: null, capped_total: { min: 0, max: 0 } },
  verdict: { ok: true, reason: null, message: 'Trial-funded.', change: [], warning: null },
}
