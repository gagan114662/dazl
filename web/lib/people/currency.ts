// #383 criterion 4: which found contacts are VERIFIED CURRENT and which are SEARCH RESULT ONLY.
// Windows are BUILDER-CHOSEN defaults (not a verified owner decision; Hermes kept them as defaults on PR #566, 2026-11-04)
// and can be changed without a code change via DAZL_PEOPLE_FIRST_PARTY_DAYS / DAZL_PEOPLE_PROVIDER_DAYS. A contact is
// verified current only on dated evidence:
//   (a) a first-party company page (the company's own site, read by dazl's crawl) names them in that role, and that
//       reading is within FIRST_PARTY_DAYS (180) days;
//   (b) the provider's own record (Apollo / People Data Labs) carries a last-confirmed or updated date within
//       PROVIDER_DAYS (90) days;
//   (c) a tenant LinkedIn session shows the title live: NOT counted yet. It waits for the #192 automated-actions
//       follow-up, so 'adv:linkedin' rows stay search-result-only until that lands.
// Everything else (public search hits, SEC filings, undated provider rows) is search-result-only. Fail closed: an
// unparseable, missing, future or out-of-window date, a forged label on another connector, a missing title or a title
// that contradicts the role (former, assistant-to, ...) is search-result-only. Nothing here calls a provider.

export type Currency = 'verified_current' | 'search_only'
export type VerifiedBasis = 'first_party_page' | 'provider_record'
export interface ContactCurrency { currency: Currency; basis: VerifiedBasis | null; dated: string | null }

// A bad override (non-integer, <1, >3650) falls back to the default: never silently widen the window.
function windowDays(env: string | undefined, dflt: number): number {
  const n = env && /^\d{1,4}$/.test(env.trim()) ? Number(env) : NaN
  return Number.isInteger(n) && n >= 1 && n <= 3650 ? n : dflt
}
export const FIRST_PARTY_DAYS = windowDays(process.env.DAZL_PEOPLE_FIRST_PARTY_DAYS, 180)
export const PROVIDER_DAYS = windowDays(process.env.DAZL_PEOPLE_PROVIDER_DAYS, 90)
const DAY_MS = 86_400_000
const SKEW_MS = 5 * 60_000 // a clock a few minutes ahead is not "the future"; anything more is

const PROVIDER_NAME: Record<string, string> = { 'enrich:apollo': 'Apollo', 'enrich:pdl': 'People Data Labs' }
const SEARCH_ONLY: ContactCurrency = { currency: 'search_only', basis: null, dated: null }

// A provider date field -> 'YYYY-MM-DD' (UTC), or null. Accepts 'YYYY-MM-DD', a full ISO timestamp, or PDL's
// month-only 'YYYY-MM' (taken as the 1st: older, never newer, than the record). Anything else is null: numbers,
// lists, objects, booleans, year-only, impossible dates (2026-02-30), strings over 40 chars.
export function isoDay(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 40) return null
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(v.trim())
  if (!m) return null
  const y = Number(m[1]), mo = Number(m[2]), d = m[3] ? Number(m[3]) : 1
  if (m[4] !== undefined && !m[3]) return null // a time needs a day
  const t = Date.UTC(y, mo - 1, d)
  const back = new Date(t)
  if (y < 1990 || back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null
  return back.toISOString().slice(0, 10)
}

// The most recent valid date among a provider record's last-confirmed / updated fields, or null.
export function latestDay(...vals: unknown[]): string | null {
  const days = vals.map(isoDay).filter((d): d is string => d !== null).sort()
  return days.length ? days[days.length - 1] : null
}

// The stored label of a provider contact row: the provider's name, plus its record date when the provider gave one.
// The date rides in the label (no schema change); providerRecordDay reads it back strictly.
export function providerContactLabel(connector: string, recordDay: string | null): string {
  const name = PROVIDER_NAME[connector] ?? connector
  const day = isoDay(recordDay)
  return day ? `${name}, record dated ${day}` : name
}
function providerRecordDay(connector: string | undefined, label: string | null): string | null {
  const name = connector ? PROVIDER_NAME[connector] : undefined
  if (!name || typeof label !== 'string') return null
  const m = /^(Apollo|People Data Labs), record dated (\d{4}-\d{2}-\d{2})$/.exec(label)
  return m && m[1] === name ? isoDay(m[2]) : null
}

const within = (whenMs: number, nowMs: number, days: number) => whenMs <= nowMs + SKEW_MS && nowMs - whenMs <= days * DAY_MS

export interface CurrencyRow { kind: string; connector?: string; label: string | null; retrieved_at?: unknown }
// `roleHeld`: the row names a title and the title does not contradict the role (the caller knows the buyer roles).
export function contactCurrency(r: CurrencyRow, roleHeld: boolean, nowMs: number = Date.now()): ContactCurrency {
  if (!roleHeld || !Number.isFinite(nowMs)) return SEARCH_ONLY
  if (r.connector === 'sitecrawl' && r.kind === 'person') {
    const sec = typeof r.retrieved_at === 'number' ? r.retrieved_at : typeof r.retrieved_at === 'string' && /^\d{1,12}$/.test(r.retrieved_at) ? Number(r.retrieved_at) : NaN
    if (!Number.isSafeInteger(sec) || sec <= 0) return SEARCH_ONLY
    const ms = sec * 1000
    return within(ms, nowMs, FIRST_PARTY_DAYS) ? { currency: 'verified_current', basis: 'first_party_page', dated: new Date(ms).toISOString().slice(0, 10) } : SEARCH_ONLY
  }
  if (r.kind === 'contact') {
    const day = providerRecordDay(r.connector, r.label)
    if (!day) return SEARCH_ONLY
    return within(Date.parse(`${day}T00:00:00Z`), nowMs, PROVIDER_DAYS) ? { currency: 'verified_current', basis: 'provider_record', dated: day } : SEARCH_ONLY
  }
  return SEARCH_ONLY
}

// Words for the leads page and the export.
export function currencyText(c: ContactCurrency, connector: string): string {
  if (c.currency !== 'verified_current') return 'search result only, not verified as current'
  return c.basis === 'first_party_page' ? `verified current: named on the company's own website, read ${c.dated}` : `verified current: ${PROVIDER_NAME[connector] ?? connector} record dated ${c.dated}`
}

// The leads page's two sections. Order within each is kept (the caller's title-match ranking).
export function splitByCurrency<T extends { currency?: Currency }>(people: T[]): { verified: T[]; searchOnly: T[] } {
  return { verified: people.filter(p => p.currency === 'verified_current'), searchOnly: people.filter(p => p.currency !== 'verified_current') }
}
