import { EXAMPLE, LATEST } from '@/lib/benchmark/published/index'
import { scorecardView, type BatchView, type SuperiorityView } from '@/lib/benchmark/published'

// #398: the published scorecard. Server-rendered from committed artifacts: no fetch, no model call, no client state.
export const metadata = { title: 'Scorecard' }

function Batch({ b, heading }: { b: BatchView; heading: string }) {
  return (
    <section className="card p-6 mb-4" aria-labelledby={`h-${b.origin}`}>
      <h2 id={`h-${b.origin}`} className="font-semibold mb-1">{heading}</h2>
      <p className="text-sm font-semibold mb-2" data-testid={`label-${b.origin}`}>{b.label}</p>
      <p className="text-sm text-[#555] mb-1">{b.meta}</p>
      <p className="text-sm text-[#555] mb-3">{b.evaluator}</p>
      <ul className="space-y-3">
        {b.systems.map(s => (
          <li key={s.system} data-testid="system" data-ran={s.ran ? '1' : '0'} className="border border-[var(--line)] rounded-xl p-4">
            <h3 className="font-semibold">{s.system}</h3>
            <p className="text-sm text-[#555]">{s.line}</p>
            {s.facts.length > 0 && (
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                {s.facts.map(f => <div key={f.label} className="contents"><dt className="text-[#6b6b6b]">{f.label}</dt><dd className="text-right font-medium">{f.value}</dd></div>)}
              </dl>
            )}
          </li>
        ))}
      </ul>
      <p className="text-xs text-[#6b6b6b] mt-3">{b.note}</p>
    </section>
  )
}

function Superiority({ s }: { s: SuperiorityView }) {
  return (
    <section className="card p-6 mb-4" aria-labelledby="h-sup">
      <h2 id="h-sup" className="font-semibold mb-1">Repeated-run comparison</h2>
      <p className="text-sm font-semibold" data-testid="overall">{s.overall}</p>
      <p className="text-sm text-[#555] mb-2">{s.why}</p>
      <p className="text-xs text-[#6b6b6b] mb-3">{s.plan}</p>
      <ul className="space-y-2 mb-3">
        {s.metrics.map(m => <li key={m.metric} className="text-sm"><span className="font-medium">{m.metric}: {m.decision}.</span> <span className="text-[#555]">{m.detail}</span></li>)}
      </ul>
      <ul className="space-y-1 text-sm text-[#555]">
        {s.floors.map(f => <li key={f.id}>Floor {f.id}: {f.state}. {f.detail}</li>)}
        {s.targets.map(t => <li key={t}>{t}</li>)}
      </ul>
    </section>
  )
}

export default function ScorecardPage() {
  const v = scorecardView(LATEST, EXAMPLE)
  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-bold mb-1">Scorecard</h1>
      <p className="text-[#555] text-sm mb-4" data-testid="headline">{v.headline}</p>
      {v.live && <Batch b={v.live} heading="Same briefs, same budget, judged blind" />}
      {v.superiority ? <Superiority s={v.superiority} /> : <p className="text-sm text-[#555] mb-4" data-testid="sup-note">{v.superiorityNote}</p>}
      <Batch b={v.example} heading="Example layout (invented data)" />
      <section className="card p-6 mb-4" aria-labelledby="h-limits">
        <h2 id="h-limits" className="font-semibold mb-2">What this does and does not show</h2>
        <ul className="list-disc pl-5 space-y-1 text-sm text-[#555]">{v.limits.map(l => <li key={l}>{l}</li>)}</ul>
      </section>
    </div>
  )
}
