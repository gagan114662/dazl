import { Suspense } from 'react'
import { SignInForm } from '../sign-up/sign-up-form'
import { PublicTrialAllowance } from '../trial-allowance'

export default function SignIn() {
  return <SignInForm trialRule={<Suspense fallback={null}><PublicTrialAllowance /></Suspense>} />
}
