'use client'
// #1038 (PR 2 of 3): the side panel a table row opens. Same display logic as the cards and the table
// (leadCardSummary / leadPerson / ContactStatusLine), prev/next walking the visible (tab-filtered,
// sorted) order via the client. No actions here on purpose: Approve/Reject stay on the cards, bulk is
// the next PR.
import { leadCardSummary } from '@/lib/scan/lead-card'
import { leadPerson } from '@/lib/people/lead-person'
import { identityOf } from '@/lib/scan/opportunity'
import { ContactStatusLine } from './contact-status'
import { Pill } from '../ui/bits'

type TableLead = Parameters<typeof leadCardSummary>[0] & { id: string }

export default function LeadsSidePanel({ lead, icpWho, drafted, approved, hasPrev, hasNext, onPrev, onNext, onClose }: {
  lead: TableLead
  icpWho: string
  drafted: Set<string> | null | undefined
  approved: Record<string, unknown>
  hasPrev: boolean
  hasNext: boolean
  onPrev: () => void
  onNext: () => void
  onClose: () => void
}) {
  const c = leadCardSummary(lead, icpWho)
  const person = leadPerson(lead.enrichments, icpWho, undefined, identityOf({ id: lead.id, contact: lead.contact }, lead.enrichments ?? []))
  return (
    <aside data-testid="leads-side-panel" className="fixed inset-y-0 right-0 z-40 w-full sm:w-96 overflow-y-auto bg-[var(--panel)] border-l border-[var(--line)] shadow-xl p-4 text-sm">
      <div className="flex items-center justify-between mb-3">
        <div className="flex gap-1">
          <button type="button" data-testid="side-panel-prev" disabled={!hasPrev} onClick={onPrev} className="btn-ghost btn-sm disabled:opacity-40">Prev</button>
          <button type="button" data-testid="side-panel-next" disabled={!hasNext} onClick={onNext} className="btn-ghost btn-sm disabled:opacity-40">Next</button>
        </div>
        <button type="button" aria-label="Close" onClick={onClose} className="text-[var(--ink-3)] hover:text-[var(--ink)] px-2">✕</button>
      </div>
      <h2 className="text-base font-semibold">{c.company}</h2>
      <div className="mt-1">
        {person
          ? <><span>{person.name}</span>{person.title ? <span className="block text-xs text-[var(--ink-3)]">{person.title}</span> : null}</>
          : <span className="text-[var(--ink-3)]">No buyer named yet</span>}
      </div>
      <dl className="mt-3 space-y-3">
        <div>
          <dt className="text-xs text-[var(--ink-3)]">Signal</dt>
          <dd>{lead.signal}{c.date ? <span className="block text-xs text-[var(--ink-3)] mt-0.5">{c.date}</span> : null}</dd>
        </div>
        {c.why && c.why !== lead.signal ? (
          <div>
            <dt className="text-xs text-[var(--ink-3)]">Why it fits</dt>
            <dd>{c.why}</dd>
          </div>
        ) : null}
        <div>
          <dt className="text-xs text-[var(--ink-3)]">Source</dt>
          <dd><a className="underline break-all" href={c.sourceUrl} target="_blank" rel="noopener noreferrer nofollow">Proof: {c.sourceHost}</a></dd>
        </div>
        <div>
          <dt className="text-xs text-[var(--ink-3)]">Fit</dt>
          <dd>{lead.fit ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-xs text-[var(--ink-3)]">Email</dt>
          <dd>{c.contactStatus ? <ContactStatusLine status={c.contactStatus} /> : <span className="text-[var(--ink-3)]">—</span>}</dd>
        </div>
        <div>
          <dt className="text-xs text-[var(--ink-3)]">Approval</dt>
          <dd>
            {lead.quarantined_at
              ? <Pill tone="pink">Rejected</Pill>
              : approved[lead.id] || drafted?.has(lead.id)
              ? <Pill tone="mint">Approved</Pill>
              : <span className="text-xs text-[var(--ink-3)]">To decide</span>}
          </dd>
        </div>
      </dl>
    </aside>
  )
}
