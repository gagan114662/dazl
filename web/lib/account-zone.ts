// #2054: one shared helper for "the account's own day". Per-account limits restart at midnight in the ACCOUNT's
// time zone - the zone saved at signup - because dazl launches worldwide: one fixed zone would turn an account's
// day in the middle of its evening or morning. That covers the send caps (lib/outreach/send-budget.ts), the
// per-account trial scan count (lib/scan/trial.ts) and every reset time a customer is shown. It does NOT cover
// the global trial ceiling (lib/billing/trial-budget.ts): that money is the platform's, so its day is the one
// UTC platform day for every account. Where no zone is saved (or the saved value is not a real zone), the day
// is UTC's.
// The day math is pure and client-safe (Intl only); the reader at the bottom is the server side: it reads the
// account's saved zone on the Db layer, defensively, the way accountCreatedAt reads its age
// (lib/outreach/send-budget.ts), so a store whose schema has no timezone column yet simply has no saved zone
// and every caller falls back.
import type { Db } from './db/client.ts'

export const FALLBACK_ZONE = 'UTC'

const formatters = new Map<string, Intl.DateTimeFormat>()
function dateParts(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
    formatters.set(zone, f)
  }
  return f
}

// A zone Intl can actually use; anything else is no zone.
export function validZone(tz: string | null | undefined): boolean {
  if (!tz) return false
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true } catch { return false }
}
export function zoneOrFallback(tz?: string | null): string {
  return tz && validZone(tz) ? tz : FALLBACK_ZONE
}

// The calendar date of an instant in a zone, as YYYY-MM-DD.
export function dateInZone(nowS: number, zone: string): string {
  const p = Object.fromEntries(dateParts(zone).formatToParts(new Date(nowS * 1000)).map(x => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day}`
}
// A day's number: days since 1970-01-01 of the zone-local calendar date - the same numbering a UTC day has,
// so day numbers written under any one zone keep their meaning as dates.
export function dayNumber(nowS: number, zone: string): number {
  return Math.floor(Date.parse(`${dateInZone(nowS, zone)}T00:00:00Z`) / 86_400_000)
}
// The unix second a zone-local day starts. Exact on clock-change days (a 23- or 25-hour day starts where the
// previous day ends, not 24 hours before the next): the start lies within 18 hours of the day's UTC midnight,
// so step that window in half hours to the first instant of the day, then binary-search the boundary second.
export function dayStartUnix(day: number, zone: string): number {
  let t = day * 86400 - 18 * 3600
  while (dayNumber(t, zone) < day) t += 1800
  let lo = t - 1800, hi = t
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2)
    if (dayNumber(mid, zone) === day) hi = mid; else lo = mid
  }
  return hi
}
// The start of the zone-local day holding this instant.
export function dayStartOfInstant(nowS: number, zone: string): number {
  return dayStartUnix(dayNumber(nowS, zone), zone)
}

// The account's saved zone, read on the Db layer (SQLite or Postgres): the user's row, else the workspace's.
// A table or column the store does not have fails the query, which reads as no saved zone, never as an error -
// and neither does a saved value that is not a real zone: both read as null, and the caller falls back.
export async function readAccountZone(db: Db, tenantId: string): Promise<string | null> {
  for (const table of ['users', 'organizations']) {
    try {
      const row = await db.get<{ timezone?: unknown }>(`SELECT timezone FROM ${table} WHERE id = ?`, [tenantId])
      if (typeof row?.timezone === 'string' && validZone(row.timezone)) return row.timezone
    } catch { /* no such table or column on this store: it says nothing */ }
  }
  return null
}
