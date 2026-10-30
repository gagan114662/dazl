// What the Follow-ups page asks the user for, from its overview (enabled, connected account). Pure and client-safe, so
// the page does not import the server-side follow-up runner (lib/outreach/followups.ts re-exports it).
// 'none'    - everything is on, nothing to ask.
// 'switch'  - Gmail is connected; only the follow-ups switch is off. Asking the user
//             to "Connect Gmail" here contradicts the "Gmail connected as ..." line.
// 'connect' - Gmail is not connected; the switch is moot until it is.
export type FollowupAsk = 'none' | 'switch' | 'connect'
export function followupAsk(o: { enabled: boolean; account: string | null }): FollowupAsk {
  if (o.enabled) return 'none'
  return o.account ? 'switch' : 'connect'
}
