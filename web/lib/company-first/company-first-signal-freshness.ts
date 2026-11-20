const dayMs = 24 * 60 * 60 * 1_000
const maxSignalAgeDays = 45

// Compare publisher-proven calendar days in UTC. Invalid, future and
// undated signals never reach the contact stage, even on a wider brief.
export function isRecentCompanyFirstSignal(date: unknown, now = Date.now()): boolean {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(now)) return false
  const eventMs = Date.parse(date)
  if (!Number.isFinite(eventMs) || new Date(eventMs).toISOString().slice(0, 10) !== date) return false
  const days = Math.floor(now / dayMs) - eventMs / dayMs
  return days >= 0 && days <= maxSignalAgeDays
}
