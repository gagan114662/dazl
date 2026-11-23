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
