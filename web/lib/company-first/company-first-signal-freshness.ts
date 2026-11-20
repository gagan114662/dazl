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

// A non-null closing deadline is actionable only if it is a valid
// timestamp with an explicit offset. Date-only or ambiguous clocks hold.
export function isCurrentCompanyFirstDeadline(v:unknown, now:number):boolean {
  if(v===undefined||v===null)return true
  if(typeof v!=='string')return false
  const m=/^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(v)
  if(!m)return false
  const day=new Date(m[1])
  return Number.isFinite(+day)&&day.toISOString().slice(0,10)===m[1]&&Date.parse(v)>now
}
