// #1037: the first play (first5) and free-trial scans also look up who to contact, one search per ready lead that names
// nobody yet, at most this many per scan (DAZL_FIRST_PLAY_PEOPLE_SEARCHES can lower it; 0 turns it off). A count cap on
// TinyFish searches, which also count against the tenant / global daily caps inside tfSearch.
// Pure (no data layer): the run-budget disclosure and the price estimate, both also imported by client components, state it.
export const FIRST_PLAY_MAX = 10
export function firstPlayPeopleCap(env: Record<string, string | undefined> = process.env): number {
  const raw = env.DAZL_FIRST_PLAY_PEOPLE_SEARCHES
  if (typeof raw !== 'string' || raw.trim() === '') return FIRST_PLAY_MAX
  // Anything that is not a plain non-negative integer fails closed to 0 (off), never to a larger number.
  if (!/^\d{1,3}$/.test(raw.trim())) return 0
  return Math.min(FIRST_PLAY_MAX, Number(raw.trim()))
}

// #1037 item 1: a first play whose free news search cannot serve it (switched off, not run, failed or found nothing usable) falls back to
// the existing TinyFish lead search, HARD-capped per run: DAZL_FIRST_PLAY_LEAD_SEARCHES (default 3) searches and
// DAZL_FIRST_PLAY_LEAD_FETCHES (default 6) page reads. Each setting can only lower its default; anything that is not a plain
// non-negative integer is 0; searches 0 turns the fallback off. A free-trial play pays each from its trial reserve as before.
export const FIRST_PLAY_LEAD_SEARCHES_MAX = 3
export const FIRST_PLAY_LEAD_FETCHES_MAX = 6
export function firstPlayLeadCaps(env: Record<string, string | undefined> = process.env): { searches: number; fetches: number } {
  const n = (raw: string | undefined, max: number) => { if (typeof raw !== 'string' || raw.trim() === '') return max; return /^\d{1,3}$/.test(raw.trim()) ? Math.min(max, Number(raw.trim())) : 0 }
  return { searches: n(env.DAZL_FIRST_PLAY_LEAD_SEARCHES, FIRST_PLAY_LEAD_SEARCHES_MAX), fetches: n(env.DAZL_FIRST_PLAY_LEAD_FETCHES, FIRST_PLAY_LEAD_FETCHES_MAX) }
}
