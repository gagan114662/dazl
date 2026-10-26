'use client'
import { opportunityCard, type CardLead } from '@/lib/scan/opportunity'

// The opportunity card (owner direction #204): the lead as one decision. All text comes from lib/scan/opportunity.ts,
// which only reads stored data; unknowns are shown as missing, never filled in. Short by default: why now, who and the
// next action; the certainty split opens on demand.
export function OpportunityCardView({ lead, buyerRoles }: { lead: CardLead; buyerRoles: string }) {
  const c = opportunityCard(lead, buyerRoles)
  return (
    <div className="text-xs border border-black/10 rounded p-2 my-2 space-y-1">
      <div><span className="text-gray-500">Why now: </span>{c.whyNow.claim} <span className="text-gray-500">({c.whyNow.dateNote}, </span><a className="underline" href={c.whyNow.source} target="_blank" rel="noopener noreferrer nofollow">source</a><span className="text-gray-500">)</span></div>
      <div><span className="text-gray-500">Who: </span>{c.who ? <>{c.who.name}{c.who.title ? `, ${c.who.title}` : ''}{c.who.link && <> <a className="underline" href={c.who.link} target="_blank" rel="noopener noreferrer nofollow">link</a></>} <span className="text-gray-500">({c.who.identity})</span></> : <span className="text-gray-500">nobody found yet</span>}</div>
      <div className="font-medium"><span className="text-gray-500 font-normal">Next: </span>{c.next}</div>
      <details>
        <summary className="text-gray-500 cursor-pointer">Why this business, what is known and what is missing</summary>
        <div className="space-y-1 mt-1">
          <div><span className="text-gray-500">Why this business: </span>{c.whyThisBusiness}</div>
          {c.angle && <div><span className="text-gray-500">Angle: </span>{c.angle}</div>}
          {c.facts.length > 0 && <div><span className="text-gray-500">Facts: </span>{c.facts.join(' ')}</div>}
          <div><span className="text-gray-500">Assumptions: </span>{c.assumptions.join(' ')}</div>
          {c.missing.length > 0 && <div><span className="text-gray-500">Missing: </span>{c.missing.join('; ')}</div>}
        </div>
      </details>
    </div>
  )
}
