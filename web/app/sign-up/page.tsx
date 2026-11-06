import { Suspense } from 'react'
import { connection } from 'next/server'
import { operatorKey } from '@/lib/scan/trial'
import SignUpForm from './sign-up-form'

// Runtime deployment availability only (#668): whether a trial is funded here is an env fact read at request time,
// never baked into the build and never implying anything about this specific visitor's own trial eligibility or use.
async function RuntimeSignUp() {
  await connection()
  return <SignUpForm trialFunded={!!operatorKey()} />
}
export default function SignUp() {
  return <Suspense fallback={<main id="main" className="min-h-screen flex items-center justify-center">Loading...</main>}><RuntimeSignUp /></Suspense>
}
