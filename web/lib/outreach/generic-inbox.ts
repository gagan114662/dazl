// A shared inbox is not a contact (#1250, owner decision 2026-11-23): sales@, info@, reception@, founders@ and the like reach a
// desk, not the named person. Pure and dependency-free, so the browser's lead card and the server's draft check read the same rule.
export const GENERIC_LOCAL = /^(?:hello|hi|info|information|contact|contactus|enquiries|enquiry|inquiries|inquiry|office|admin|team|sales|mail|general|reception|frontdesk|bookings?|appointments?|studio|clinic|hq|business|partners?|partnerships?|newbusiness)$/
// Desks named for a group rather than a person. Function desks (press, support, privacy, careers ...) are refused by their own rule,
// lib/outreach purpose classification, with its own wording.
const DESK_LOCAL = /^(?:founders?|cofounders?|owners?|management|leadership|directors?|staff|everyone|all|ask|connect|welcome|questions?|feedback|inbox|email|web|website|online)$/
export function isGenericInbox(email: string | null | undefined): boolean {
  const local = (email ?? '').trim().toLowerCase().split('@')[0].split('+')[0].replace(/[._-]/g, '')
  return !!local && (GENERIC_LOCAL.test(local) || DESK_LOCAL.test(local))
}

// Does the address's local part carry this person's own name (first, last, first.last, flast, firstl...)? A published
// address shaped like the person's name is the only person binding read here; a shared inbox never is.
export function nameBound(local: string, name: string): boolean {
  const parts = name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').match(/[a-z]+/g) ?? []
  if (parts.length === 0) return false
  const l = local.split('+')[0].replace(/[._-]/g, '')
  const first = parts[0] ?? '', last = parts[parts.length - 1] ?? ''
  const shapes = new Set([first, `${first}${last}`, `${first[0]}${last}`, `${first}${last[0]}`, `${last}${first}`, `${last}${first[0]}`])
  if (parts.length === 1) return l === first && first.length >= 3
  return shapes.has(l) || (l === last && last.length >= 4)
}
