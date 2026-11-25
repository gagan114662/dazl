export interface ZeroResultInput {
  stop: string | null
  query: string
  offer?: string | null
  searchesUsed: number
  searchAllowance: number
  candidates: number
  rejected: number
}

export interface ZeroResultReason {
  code: 'unsupported_region' | 'non_saas_offer' | 'signal_too_narrow' | 'budget_spent' | 'unknown'
  reason: string
  nextStep: string
  action?: { label: string; href: string }
}

// Precedence: recognized stop (including a limit stop), then any other supplied stop is unknown;
// otherwise exhausted allowance, explicit non-commercial wording, all candidates filtered, then unknown.
export function zeroResultReason(input: ZeroResultInput): ZeroResultReason {
  const stop = input.stop?.trim().toLowerCase() ?? null
  if (stop && /unsupported.?region|out.?of.?region|outside.?supported.?region/.test(stop)) {
    return {
      code: 'unsupported_region',
      reason: 'This search cannot be run in the requested region.',
      nextStep: 'Try a supported location and search again.',
    }
  }
  if (stop && /budget|limit|allowance|quota/.test(stop)) {
    return {
      code: 'budget_spent',
      reason: 'The search reached its available limit.',
      nextStep: 'Wait for the search allowance to reset, then try again.',
    }
  }
  if (stop) {
    return {
      code: 'unknown',
      reason: 'The search stopped before its outcome could be determined.',
      nextStep: 'Review the search details and try again.',
    }
  }
  if (input.searchesUsed >= input.searchAllowance) {
    return {
      code: 'budget_spent',
      reason: 'The search used its available allowance.',
      nextStep: 'Wait for the search allowance to reset, then try again.',
    }
  }

  const request = `${input.query} ${input.offer ?? ''}`.toLowerCase()
  if (/\b(?:personal use|not (?:for )?a business|non[- ]commercial|just for fun|write me (?:a )?(?:poem|story|song))\b/.test(request)) {
    return {
      code: 'non_saas_offer',
      reason: 'This request does not describe a commercial software search.',
      nextStep: 'Describe a business software need and search again.',
    }
  }
  if (input.candidates > 0 && input.rejected === input.candidates) {
    return {
      code: 'signal_too_narrow',
      reason: 'Candidates were found, but all were filtered out by the current requirements.',
      nextStep: 'Try a wider location or remove one requirement, then search again.',
    }
  }
  return {
    code: 'unknown',
    reason: 'The available information does not establish why there were no kept results.',
    nextStep: 'Review the search details and try again.',
  }
}
