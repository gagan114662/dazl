'use client'
// The website research block (#379), shown for EXPLICIT review before a scan: every sourced statement and inferred
// hypothesis per offer, with its page and quote, and the one targeting question. Nothing here is targeting until the
// person acts: "Add" puts the statement into the visible profile field above (their edit, their authority - the server
// confirms it by exact match), "Dismiss" records an explicit rejection that persists across recrawls. A statement the
// person never acts on keeps its truth status (sourced / inferred) and is neither confirmed nor rejected.
import { useState } from 'react'

export type ResearchHyp = { i: string; o: string; k: string; t: string; s: string; u: string | null; q: string | null; at: number | null }
export type ResearchBlock = { v: 1; site: string; q: string | null; ans: { q: string; o: string; t?: string } | null; offers: { i: string; n: string }[]; hyps: ResearchHyp[] }

const FIELD_OF: Record<string, 'who' | 'industries' | 'sizes' | 'where' | 'exclude'> = { persona: 'who', industry: 'industries', size: 'sizes', location: 'where', disqualifier: 'exclude' }
const OFFER_QUESTION = 'Which of your offers is this play for?'
const WHO_QUESTION = 'Who buys this?'
const KIND_LABEL: Record<string, string> = { persona: 'buyer', industry: 'industry', size: 'company size', location: 'place', disqualifier: 'not a fit', pain: 'pain' }

export function asResearchBlock(x: unknown): ResearchBlock | null {
  if (!x || typeof x !== 'object') return null
  const r = x as ResearchBlock
  return Array.isArray(r.offers) && Array.isArray(r.hyps) ? r : null
}

export default function ResearchReview({ research, onChange, onAdd, onRemove }: {
  research: ResearchBlock
  onChange: (r: ResearchBlock) => void
  onAdd: (field: 'who' | 'industries' | 'sizes' | 'where' | 'exclude', text: string) => void
  onRemove: (field: 'who' | 'industries' | 'sizes' | 'where' | 'exclude', text: string) => void
}) {
  const [answer, setAnswer] = useState('')
  // Dismiss rejects the statement AND removes its exact text from the visible field in the same action: the draft the
  // person sees is the authority, with no hidden contradiction a later exact-match could resurrect.
  const dismiss = (id: string) => {
    const h = research.hyps.find(x => x.i === id)
    const field = h ? FIELD_OF[h.k] : undefined
    if (h && field) onRemove(field, h.t)
    onChange({ ...research, hyps: research.hyps.map(x => x.i === id ? { ...x, s: 'rejected' } : x) })
  }
  const answerOffer = (offerId: string) => research.q ? onChange({ ...research, ans: { q: research.q, o: offerId } }) : null
  const answerWho = () => {
    const t = answer.trim()
    if (!t || !research.q) return
    onAdd('who', t)   // the typed answer lands in the visible profile field - the person's own words, editable
    onChange({ ...research, ans: { q: research.q, o: research.offers[0]?.i ?? '', t } })   // ...and persists IN the block, so a recrawl carries it
    setAnswer('')
  }
  const visible = research.hyps.filter(h => h.k !== 'offer' && h.s !== 'rejected')
  if (visible.length === 0 && !research.q) return null
  return (
    <div className="border border-[var(--line,#333)] rounded p-3 mb-3" data-testid="research-review">
      <p className="text-xs uppercase tracking-wide text-[var(--ink-2,#888)] mb-2">From your website ({research.site}) - review before the scan</p>
      {research.offers.map(o => {
        const hs = visible.filter(h => h.o === o.i)
        if (hs.length === 0) return null
        return (
          <div key={o.i} className="mb-2">
            {research.offers.length > 1 && <p className="text-sm font-medium mb-1">{o.n}</p>}
            <ul className="space-y-1">
              {hs.map(h => (
                <li key={h.i} className="flex items-start gap-2 text-sm" data-testid={`hyp-${h.i}`}>
                  <span className="flex-1">
                    <span className="text-[var(--ink-2,#888)]">{KIND_LABEL[h.k] ?? h.k}: </span>{h.t}
                    {h.s === 'sourced' && h.q
                      ? <span className="block text-xs text-[var(--ink-2,#888)]">on your site: &ldquo;{h.q}&rdquo;{h.u ? <> - <a className="underline" href={h.u} target="_blank" rel="noreferrer">{h.u}</a></> : null}</span>
                      : h.s === 'reviewed' && !h.q
                        ? <span className="block text-xs text-[var(--ink-2,#888)]">added by you</span>
                        : <span className="block text-xs text-[var(--ink-2,#888)]">inferred - not stated on your site</span>}
                  </span>
                  {FIELD_OF[h.k] && <button type="button" className="text-xs underline shrink-0" onClick={() => onAdd(FIELD_OF[h.k], h.t)}>Add</button>}
                  <button type="button" className="text-xs underline shrink-0" onClick={() => dismiss(h.i)}>Dismiss</button>
                </li>
              ))}
            </ul>
          </div>
        )
      })}
      {research.q && !research.ans && (
        <div className="mt-2" data-testid="research-question">
          <p className="text-sm mb-1">{research.q}</p>
          {research.q === OFFER_QUESTION
            ? <div className="flex gap-2 flex-wrap">{research.offers.map(o => <button key={o.i} type="button" className="text-xs underline" onClick={() => answerOffer(o.i)}>{o.n}</button>)}</div>
            : research.q === WHO_QUESTION
              ? <div className="flex gap-2"><input className="border border-[var(--line,#333)] bg-transparent px-2 py-1 text-sm flex-1" maxLength={120} value={answer} onChange={e => setAnswer(e.target.value)} placeholder="e.g. practice managers at dental clinics" /><button type="button" className="text-xs underline" onClick={answerWho} disabled={!answer.trim()}>Save</button></div>
              : null}
        </div>
      )}
      {research.ans && <p className="text-xs text-[var(--ink-2,#888)] mt-1" data-testid="research-answered">Answered: {research.ans.q}{research.ans.t ? ` - ${research.ans.t}` : ''}</p>}
    </div>
  )
}
