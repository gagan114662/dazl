'use client'
// The line beside a lead's contact that says how far it is established (lib/scan/lead-card.ts contactStatus). In its own file so the
// header a person reads can be rendered, in a test, from a real lead-list row (#1571). Markup unchanged from the Leads page.
import InfoTip from '../ui/info-tip.tsx'
import { Pill } from '../ui/bits.tsx'

export function ContactStatusLine({ status }: { status: { confirmed: boolean; text: string } | null }) {
  if (!status) return null
  // A plain confirmation (one sentence, nothing in doubt) is a small mark with its basis behind the (i); any
  // doubt - unconfirmed, role not verified, no current buyer - stays on screen in full.
  return status.confirmed && /^Confirmed: [^.]+\.$/.test(status.text)
    ? <div className="text-xs mt-1"><Pill tone="mint">Source confirmed</Pill><InfoTip label="Where the contact was published"><span data-testid="contact-status">{status.text}</span></InfoTip></div>
    : <div data-testid="contact-status" className={`text-xs ${status.confirmed ? 'text-[var(--ink-2)] mt-0.5' : 'text-[#111] font-medium border-l-2 border-black pl-2 mt-0.5'}`}>{status.text}</div>
}
