// The hold reasons of lib/journey.ts heldReason in the words Home and the checked-leads list show. Browser-safe.
const WORDS: Record<string, [string, string]> = {   // [one, many]
  'needs your review': ['needs your review', 'need your review'], 'a required check has not passed': ['held by a required check', 'held by a required check'],
  'source not verified': ['source not verified', 'source not verified'], 'outside your time window or undated': ['outside your time window or undated', 'outside your time window or undated'],
  'event timing unknown': ['event timing not confirmed', 'event timing not confirmed'], 'no verified date': ['no verified date', 'no verified date'],
  'company website not confirmed': ['company website not confirmed', 'company website not confirmed'], 'not a fit': ['not a fit', 'not a fit'],
  // #1062: a company-first scan's final checks keep it off its run page (lib/outreach/campaigns.ts gateHoldReason)
  'held by the final checks': ['held by the final checks', 'held by the final checks'], 'final checks not finished': ['final checks not finished yet', 'final checks not finished yet'],
}
export const holdWords = (reason: string, count: number): string => (WORDS[reason] ?? [reason, reason])[count === 1 ? 0 : 1]
