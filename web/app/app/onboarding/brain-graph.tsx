'use client'
import type { BrainFact, FactKind } from '@/lib/brain'

// The brain as a drifting graph: one node per inferred fact, placed deterministically (no randomness between renders),
// each drifting slowly on its own loop. `shown` reveals facts one by one as they are placed; `faint` is the background
// of the ready screen. Decorative: the facts are also listed as text on the page for screen readers.
const TONE: Record<FactKind, string> = {
  company: '#2a0a24', product: '#2a0a24', buyer: '#7c4dff', persona: '#7c4dff', industry: '#1f8a5b', place: '#1f8a5b',
  size: '#c46a12', signal: '#d6336c', skip: '#8a7a88',
}
const PLACEHOLDER = ['Company', 'Product', 'Ideal customer', 'Persona', 'Region', 'Buying signal']

export default function BrainGraph({ facts, shown, faint = false, reading = false }: { facts: BrainFact[]; shown: number; faint?: boolean; reading?: boolean }) {
  const nodes = reading && facts.length === 0
    ? PLACEHOLDER.map((label, i) => ({ key: `p${i}`, label, text: '', color: '#b9a9b6', i, ghost: true }))
    : facts.slice(0, shown).map((f, i) => ({ key: `${f.kind}-${f.text}`, label: f.label, text: f.text, color: TONE[f.kind], i, ghost: false }))
  // Golden-angle spiral around the centre, stretched to the screen; the centre stays clear for the headline.
  const pos = (i: number) => { const a = i * 2.39996, r = 0.30 + 0.17 * ((i * 7) % 5) / 4; return { x: 50 + Math.cos(a) * r * 92, y: 50 + Math.sin(a) * r * 88 } }
  return (
    <div aria-hidden className={`brain-graph ${faint ? 'brain-faint' : ''}`} data-testid="brain-graph">
      <svg className="absolute inset-0 w-full h-full" preserveAspectRatio="none" viewBox="0 0 100 100">
        {nodes.slice(1).map((n, k) => { const a = pos(k), b = pos(k + 1); return <line key={n.key} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#2a0a24" strokeOpacity="0.07" strokeWidth="0.15" /> })}
      </svg>
      {nodes.map(n => { const p = pos(n.i); return (
        <div key={n.key} className={`brain-node ${n.ghost ? 'brain-ghost' : ''}`} data-testid={n.ghost ? 'brain-ghost' : 'brain-node'} style={{ left: `${p.x}%`, top: `${p.y}%`, animationDelay: `${-(n.i * 1.7) % 9}s`, animationDuration: `${14 + (n.i % 5) * 3}s` }}>
          <span className="brain-dot" style={{ background: n.color }} />
          <span className="brain-label" style={{ color: n.color }}>{n.label}</span>
          {n.text && <span className="brain-text">{n.text}</span>}
        </div>
      ) })}
    </div>
  )
}
