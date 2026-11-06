import { Suspense } from 'react'
import { connection } from 'next/server'
import { trialFundable } from '@/lib/billing/trial-budget'
import SignUpForm from './sign-up-form'

// Runtime deployment availability only (#668): whether a trial is funded here is an env fact read at request time,
// never baked into the build and never implying anything about this specific visitor's own trial eligibility or use.
// trialFundable, never operatorKey() alone: the operator key makes a trial POSSIBLE, but admitTrialScan also
// requires trialCaps() to resolve (spend ceilings, TinyFish) - a deployment can have the key set with those absent,
// which refuses every trial as not_configured despite looking funded (review of #670, production was in that state).
async function RuntimeSignUp() {
  await connection()
  return <SignUpForm trialFunded={trialFundable()} />
}
export default function SignUp() {
  return <Suspense fallback={<main id="main" className="min-h-screen flex items-center justify-center">Loading...</main>}><RuntimeSignUp /></Suspense>
}
