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
