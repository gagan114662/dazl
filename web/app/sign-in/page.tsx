import { Suspense } from 'react'
import { connection } from 'next/server'
import { PASSWORD_TRIAL_SCANS, passwordTrialOn, trialFundable } from '@/lib/billing/trial-budget'
import { TRIAL_SCANS_PER_ACCOUNT } from '@/lib/scan/trial'
import { systemMailAvailable } from '@/lib/system-mail'
import { trialRuleLine } from '@/lib/trial-copy'
import { SignInForm } from '../sign-up/sign-up-form'

// #1704: the free-search rule under the Google button is the sign-up page's, read the same way at request time (whether a
// trial can be admitted here, whether an email account gets its first search, and the allowance constants), so the two
// pages never tell two stories. Only that line waits on the request (connection() inside its own Suspense, as app/reset
// does): the form stays in the prerendered shell, so it is in the first HTML (no script needed) and the page's code is
// fetched with the link prefetch, as before.
async function TrialRule() {
  await connection()
  return trialRuleLine({ funded: trialFundable(), emailPath: passwordTrialOn() && systemMailAvailable(), cap: TRIAL_SCANS_PER_ACCOUNT, emailCap: PASSWORD_TRIAL_SCANS })
}
export default function SignIn() {
  return <SignInForm trialRule={<Suspense fallback={null}><TrialRule /></Suspense>} />
}
