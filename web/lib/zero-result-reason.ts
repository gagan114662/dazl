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
      reason: 'dazl covers the US and Canada for now.',
      nextStep: 'Search for companies in the US or Canada.',
    }
  }
  if (stop && /budget|limit|allowance|quota/.test(stop)) {
    return {
      code: 'budget_spent',
      reason: 'This search used all 15 of its web searches before finding a lead that passed.',
      nextStep: 'Try a narrower request, like one city or one signal, and run it again.',
    }
  }
  if (stop) {
    return {
      code: 'unknown',
      reason: "We couldn't find leads for this search.",
      nextStep: 'Try rewording it with a clear buyer and signal.',
    }
  }
  if (input.searchesUsed >= input.searchAllowance) {
    return {
      code: 'budget_spent',
      reason: 'This search used all 15 of its web searches before finding a lead that passed.',
      nextStep: 'Try a narrower request, like one city or one signal, and run it again.',
    }
  }

  const request = `${input.query} ${input.offer ?? ''}`.toLowerCase()
  if (/\b(?:personal use|not (?:for )?a business|non[- ]commercial|just for fun|write me (?:a )?(?:poem|story|song))\b/.test(request)) {
    return {
      code: 'non_saas_offer',
      reason: "We couldn't find companies showing that signal for this kind of offer.",
      nextStep: "Name the buyer and a clear sign they need you, like 'dentists in Ohio opening a second office'.",
      action: { label: 'Edit search', href: '/app/leads' },
    }
  }
  if (input.candidates > 0 && input.rejected === input.candidates) {
    return {
      code: 'signal_too_narrow',
      reason: `We found ${input.candidates} companies, but none passed the checks.`,
      nextStep: 'Try a wider area or drop one requirement.',
    }
  }
  return {
    code: 'unknown',
    reason: "We couldn't find leads for this search.",
    nextStep: 'Try rewording it with a clear buyer and signal.',
  }
}
