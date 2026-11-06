import { connection } from 'next/server'
import { trialFundable } from '@/lib/billing/trial-budget'
import SignUpForm from './sign-up-form'

// Runtime deployment availability only (#668): whether a trial is funded here is an env fact read at request time,
// never baked into the build and never implying anything about this specific visitor's own trial eligibility or use.
// trialFundable, never operatorKey() alone: the operator key makes a trial POSSIBLE, but admitTrialScan also
// requires trialCaps() to resolve (spend ceilings, TinyFish) - a deployment can have the key set with those absent,
// which refuses every trial as not_configured despite looking funded (review of #670, production was in that state).
// connection() with NO Suspense boundary around it, plus `instant = false` (review of #670): with no Suspense
// ancestor Next cannot stream a fallback-then-swap for this piece, so the route blocks until connection() resolves
// (near-instant) and sends the complete real HTML in one shot - the form is in the initial markup, not hidden
// behind an inline swap script. A Suspense-wrapped version of this exact pattern (await connection() inside the
// boundary) is what broke JS-disabled signup (test/smoke/auth-form-fallback.smoke.mjs) and is why /reset, which
// keeps that Suspense wrapper, is excluded from that smoke's cases. Without any dynamic API call at all,
// cacheComponents prerenders this route fully static at build time, baking in whatever env the build machine
// happened to have - connection() is what keeps this a live, per-request read; `instant = false` is what lets
// cacheComponents allow a blocking (non-prerendered) route without a Suspense boundary.
export const instant = false
export default async function SignUp() {
  await connection()
  return <SignUpForm trialFunded={trialFundable()} />
}
