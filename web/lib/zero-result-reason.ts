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
  if (stop && /provider.?rate.?limited|rate.?limited|\b429\b|http.?429/.test(stop)) {
    return {
      code: 'unknown',
      reason: 'The search service is busy.',
      nextStep: 'Try again in a few minutes.',
    }
  }
  const searchStop = stop !== null && /^(?:(?:web_)?search(?:es)?_(?:budget|limit|allowance|quota|used_up)(?:_|$)|max_uses_exceeded$)/.test(stop)
  const usedAllSearches = Number.isFinite(input.searchAllowance) && input.searchAllowance > 0 &&
    Number.isFinite(input.searchesUsed) && input.searchesUsed >= input.searchAllowance
  if (searchStop || (!stop && usedAllSearches)) {
    return {
      code: 'budget_spent',
      reason: usedAllSearches
        ? `This search used all ${input.searchesUsed} of its web searches before finding a lead that passed.`
        : 'This search reached its web search limit before finding a lead that passed.',
      nextStep: 'Try a narrower request, like one city or one signal, and run it again.',
    }
  }
  if (stop && /(?:^|_)(?:budget|spend(?:ing)?)(?:_|$)|^(?:over_cap|over_limit|owner_pool_limit)$/.test(stop)) {
    return {
      code: 'budget_spent',
      reason: 'This search reached its spending limit before finding a lead that passed.',
      nextStep: 'Try a narrower request to reduce the cost of the next search.',
    }
  }
  if (stop) {
    return {
      code: 'unknown',
      reason: "We couldn't find leads for this search.",
      nextStep: 'Try rewording it with a clear buyer and signal.',
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
