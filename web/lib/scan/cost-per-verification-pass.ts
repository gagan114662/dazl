// Truthful cost per verification pass for one scan. The denominator is the job's OWN verified
// counter: the leads that passed this scan's verification gate. That is hygiene, not a usable
// lead and not a prediction of a good lead (the scoreboard is a filter, not a model). Model cost
// only: credits spent on the tenant's own Apollo/PDL key are billed by those providers and are
// not visible here, and the scope label says so. Every unknown stays unknown: a running scan, an
// unrecorded cost and a zero denominator each produce a named reason - never a 0, an Infinity,
// or a made-up number. Zero passes means no ratio, NOT zero spend.
export const COST_PER_PASS_BASIS = 'leads that passed verification'
export const COST_PER_PASS_SCOPE = 'Model cost only - credits spent on your own Apollo or People Data Labs key are billed by those providers and are not included.'

export interface CostPerVerificationPass {
  basis: typeof COST_PER_PASS_BASIS
  verified: number | null
  model_usd: number | null
  usd_per_pass: number | null
  unavailable: string | null
}

export function costPerVerificationPass(input: { verified: number | null; model_usd: number | null; scanEnded: boolean }): CostPerVerificationPass {
  const { verified, model_usd, scanEnded } = input
  const base: CostPerVerificationPass = { basis: COST_PER_PASS_BASIS, verified, model_usd, usd_per_pass: null, unavailable: null }
  if (!scanEnded) return { ...base, unavailable: 'scan still running' }
  if (typeof model_usd !== 'number' || !Number.isFinite(model_usd)) return { ...base, model_usd: null, unavailable: 'model cost not recorded' }
  if (typeof verified !== 'number' || !Number.isFinite(verified)) return { ...base, verified: null, unavailable: 'verified count not recorded' }
  if (verified === 0) return { ...base, unavailable: 'no leads passed verification' }
  return { ...base, usd_per_pass: model_usd / verified }
}
