// What the follow-ups page should ask for when automatic follow-ups are not running. Pure, with no store or send imports,
// so the page's client component can use it without pulling the server's send path into the browser bundle.
// 'none'    - everything is on, nothing to ask.
// 'switch'  - Gmail is connected; only the follow-ups switch is off. Asking the user
//             to "Connect Gmail" here contradicts the "Gmail connected as ..." line.
// 'connect' - Gmail is not connected; the switch is moot until it is.
export type FollowupAsk = 'none' | 'switch' | 'connect'
export function followupAsk(o: { enabled: boolean; account: string | null }): FollowupAsk {
  if (o.enabled) return 'none'
  return o.account ? 'switch' : 'connect'
}
