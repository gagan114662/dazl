// A lead whose every contact was refused reads "Needs contact" on its card, with the refusal reason(s) underneath (live QA: a same-name practice in Pico Rivera, CA must not
// leave a New York lead looking like it simply has no contact). Pure. Only when nothing is attached: a kept contact, person, email or phone means the lead has a route, and a
// lead that was never refused anything keeps the plain "No contact found yet".
export interface NeedsContact { label: 'Needs contact'; reasons: string[] }
interface Row { kind: string; value: string }
const KEPT = new Set(['contact', 'person', 'email', 'phone'])
export function needsContact(l: { contact?: string | null; enrichments?: Row[] | null }): NeedsContact | null {
  if (l.contact?.trim()) return null
  const rows = l.enrichments ?? []
  if (rows.some(r => KEPT.has(r.kind))) return null
  const reasons = [...new Set(rows.filter(r => r.kind === 'contact_rejected').map(r => r.value.replace(/^contact rejected:\s*/i, '').trim()).filter(Boolean))].map(s => s.slice(0, 140)).slice(0, 3)
  return reasons.length ? { label: 'Needs contact', reasons } : null
}
