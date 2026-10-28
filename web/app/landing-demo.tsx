"use client"
import { useEffect, useState } from 'react'
import { EXAMPLES } from '@/lib/landing-examples'

// The homepage demo: the real flow, played on a loop, labelled as an illustrative example while its data is made up
// (lib/landing-examples.ts). A website is typed, the checks tick through, five leads are found (three shown with their
// evidence) and the Play goes live; each loop shows a different business and country, and the chips pick one. Reduced
// motion shows the finished state.
const CHECKS = ['Reading your site', 'Building your profile', 'Searching hiring & funding news', 'Checking evidence']
const N = EXAMPLES.scenarios.length
// Timeline in steps of TICK ms: typing, one step per check, leads, then the live Play, then hold and loop.
const TICK = 650
const TYPE_END = 4, CHECKS_END = TYPE_END + CHECKS.length, LEADS_AT = CHECKS_END + 1, PLAY_AT = LEADS_AT + 3, LOOP = PLAY_AT + 7

const initials = (n: string) => n.split(' ').map(w => w[0]).join('').slice(0, 2)

export default function LandingDemo() {
  // t: the step in the current run; sc: which business is shown. Each loop moves on to the next business.
  const [{ t, sc }, setRun] = useState({ t: 0, sc: 0 })
  const [still, setStill] = useState(false)
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setStill(true); setRun({ t: PLAY_AT, sc: 0 }); return } // eslint-disable-line react-hooks/set-state-in-effect
    const id = setInterval(() => setRun(r => r.t + 1 >= LOOP ? { t: 0, sc: (r.sc + 1) % N } : { t: r.t + 1, sc: r.sc }), TICK)
    return () => clearInterval(id)
  }, [])
  const S = EXAMPLES.scenarios[sc], LEADS = S.leads, URL_TEXT = S.site
  const typed = t >= TYPE_END ? URL_TEXT : URL_TEXT.slice(0, Math.ceil((URL_TEXT.length * t) / TYPE_END))
  const done = t >= LEADS_AT
  return (
    <div className="lp-demo" data-testid="landing-demo" data-step={t >= PLAY_AT ? 'live' : done ? 'leads' : t >= TYPE_END ? 'checks' : 'typing'} aria-label={EXAMPLES.real ? 'A dazl run: a website in, checks, leads found with their evidence, a Play that runs weekly' : 'Illustrative example of a dazl run, with made-up companies and people: a website in, checks, leads found, a Play that runs weekly'}>
      {!EXAMPLES.real && <div className="text-xs font-medium text-[var(--ink-3)] mb-2 text-center" data-testid="demo-label">Illustrative example · made-up companies and people</div>}
      <div className="flex flex-wrap justify-center gap-1.5 mb-3" role="group" aria-label="Pick a business to see its run" data-testid="demo-chips">
        {EXAMPLES.scenarios.map((x, i) => <button key={x.id} type="button" className="chip text-xs" aria-pressed={i === sc} onClick={() => setRun({ t: still ? PLAY_AT : 0, sc: i })}>{x.chip}</button>)}
      </div>
      <div className="lp-card p-4 sm:p-5" data-testid="demo-scenario" data-scenario={S.id}>
        <div className="text-xs font-medium text-[var(--ink-3)] mb-2">Your website</div>
        <div className="lp-url">{typed}<span className="lp-caret" aria-hidden /></div>
        <ul className="mt-4 grid sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
          {CHECKS.map((c, i) => {
            const state = t >= TYPE_END + i + 1 ? 'done' : t >= TYPE_END + i ? 'now' : 'todo'
            return <li key={c} className="flex items-center gap-2" data-state={state}>
              <span className={`lp-tick lp-tick-${state}`} aria-hidden>{state === 'done' ? '✓' : ''}</span>
              <span className={state === 'todo' ? 'text-[var(--ink-3)]' : ''}>{c}{state === 'now' ? '…' : ''}</span>
            </li>
          })}
        </ul>
      </div>
      <div className={`lp-card mt-3 p-4 sm:p-5 lp-fade ${done ? 'lp-in' : ''}`}>
        <div className="flex items-center justify-between mb-3">
          <div className="font-semibold">5 leads found</div>
          <span className="text-xs text-[var(--ink-3)]">3 of 5 shown</span>
        </div>
        <div className="grid gap-2">
          {LEADS.map((l, i) => (
            <div key={l.name} className={`lp-lead lp-fade ${t >= LEADS_AT + i ? 'lp-in' : ''}`} data-testid="demo-lead">
              <div className="flex items-start gap-3">
                <span className="lp-avatar" aria-hidden>{initials(l.name)}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0"><span className="font-semibold">{l.name}</span> <span className="text-[var(--ink-2)] text-sm">{l.title} · {l.company}</span></div>
                    <span className="pill pill-mint shrink-0">fit {l.fit}/5</span>
                  </div>
                  <blockquote className="lp-quote mt-2">“{l.quote}”</blockquote>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-2 text-xs" data-testid="demo-evidence">
                    {l.url ? <a className="pill pill-plain" href={l.url} target="_blank" rel="noopener noreferrer nofollow">{l.source}</a> : <span className="pill pill-plain">{l.source}</span>}
                    <span className="text-[var(--ink-3)]">{l.date}</span>
                    <span className="pill pill-mint">✓ Company and date checked</span>
                  </div>
                  <div className="text-sm text-[var(--ink-2)] mt-1.5">{l.why}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className={`lp-card mt-3 p-4 flex items-center justify-between gap-3 lp-fade ${t >= PLAY_AT ? 'lp-in' : ''}`} data-testid="demo-play">
        <div className="min-w-0"><div className="font-semibold">{S.play}</div><div className="text-sm text-[var(--ink-2)]">{S.where}</div></div>
        <span className="live-dot shrink-0">Live · runs weekly</span>
      </div>
    </div>
  )
}
