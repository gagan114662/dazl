import { connection } from 'next/server'
import { PASSWORD_TRIAL_SCANS, passwordTrialOn, trialFundable } from '@/lib/billing/trial-budget'
import { TRIAL_SCANS_PER_ACCOUNT } from '@/lib/scan/trial'
import { systemMailAvailable } from '@/lib/system-mail'
import { trialRuleLine } from '@/lib/trial-copy'

// Read deployment availability at request time. This is the allowance for
// each sign-up path, before any account-specific checks or spending limits.
export function readPublicTrialAllowance(): string {
  return trialRuleLine({
    funded: trialFundable(),
    emailPath: passwordTrialOn() && systemMailAvailable(),
    cap: TRIAL_SCANS_PER_ACCOUNT,
    emailCap: PASSWORD_TRIAL_SCANS,
  })
}

export async function PublicTrialAllowance() {
  await connection()
  return readPublicTrialAllowance()
}
