// The hold reasons of lib/journey.ts heldReason in the words Home and the checked-leads list show. Browser-safe.
const WORDS: Record<string, [string, string]> = {   // [one, many]
  'needs your review': ['needs your review', 'need your review'], 'a required check has not passed': ['held by a required check', 'held by a required check'],
  'source not verified': ['source not verified', 'source not verified'], 'outside your time window or undated': ['outside your time window or undated', 'outside your time window or undated'],
  'event timing unknown': ['event timing not confirmed', 'event timing not confirmed'], 'no verified date': ['no verified date', 'no verified date'],
  'company website not confirmed': ['company website not confirmed', 'company website not confirmed'], 'not a fit': ['not a fit', 'not a fit'],
  // #1037: no person listed on the company's own website with title and the LinkedIn that page links
  "no buyer named on the company's own site": ["no buyer named on the company's own site", "no buyer named on the company's own site"],
  // #1062: a company-first scan's final checks keep it off its run page (lib/outreach/campaigns.ts gateHoldReason)
  'held by the final checks': ['held by the final checks', 'held by the final checks'], 'final checks not finished': ['final checks not finished yet', 'final checks not finished yet'],
}
export const holdWords = (reason: string, count: number): string => (WORDS[reason] ?? [reason, reason])[count === 1 ? 0 : 1]

// #1620: Home's "Last N days" tiles count every search of the account, one line per company. Beside one search's own numbers (its page,
// its play card, the checklist) that read as a disagreement (Quest on prod, 2026-11-23: 7 against 2). The heading and one line say the scope.
export const homeWindowHeading = (days: number): string => `Last ${days} days, all your searches`
export const homeWindowScope = (days: number): string => `These numbers add up every search you ran in the last ${days} days, one count per company. A single search shows its own, smaller numbers on its page.`

// The count beside Home's "Latest leads". It printed the lead ROWS found in the window (lib/outreach/home-results.ts tiles.leads: a company
// found by two searches, or found again by a repeat, counts each time) as "N new", under a scope line that says "one count per company" and
// beside "Not ready yet (N of M companies checked)", which counts COMPANIES (lib/outreach/home-ready.ts judged). Production (2026-11-24):
// "15 new" beside 13 companies. With the ready read complete it says that read's number, so ready + not ready add up to it; while that read
// loads there is no count; when it failed or a limit cut it short, the rows are counted and named as what they are.
export function latestLeadsCount(leadRows: number, ready: { judged: number; capped: boolean } | 'failed' | null): string {
  if (ready === null) return ''
  if (ready === 'failed' || ready.capped) return `(${leadRows} found, counting a company once for each search that found it)`
  return `(${ready.judged} new ${ready.judged === 1 ? 'company' : 'companies'})`
}
