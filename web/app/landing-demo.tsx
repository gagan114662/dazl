"use client"
import { useEffect, useState } from 'react'

// The homepage demo: the real flow, played on a loop, labelled as an illustrative example (made-up data). A website is typed, the checks tick through,
// five leads are found (three shown) and the Play goes live. Reduced motion shows the finished state.
const URL_TEXT = 'brightsmile-dental.com'
const CHECKS = ['Reading your site', 'Building your profile', 'Searching hiring & funding news', 'Checking evidence']
const LEADS = [
  { name: 'Maya Lindqvist', title: 'Founder', company: 'Northside Ortho', fit: 5, quote: '“We’re opening our second clinic in Columbus this spring.”', date: '14 Oct 2026' },
  { name: 'Omar Haddad', title: 'Practice owner', company: 'Kite Family Dental', fit: 5, quote: '“Now hiring two front-desk coordinators.”', date: '9 Oct 2026' },
  { name: 'Priya Raman', title: 'Operations lead', company: 'Clearview Smiles', fit: 4, quote: '“Clearview Smiles closes a $4M growth round.”', date: '2 Oct 2026' },
]
// Timeline in steps of TICK ms: typing, one step per check, leads, then the live Play, then hold and loop.
const TICK = 650
const TYPE_END = 4, CHECKS_END = TYPE_END + CHECKS.length, LEADS_AT = CHECKS_END + 1, PLAY_AT = LEADS_AT + 3, LOOP = PLAY_AT + 7

const initials = (n: string) => n.split(' ').map(w => w[0]).join('').slice(0, 2)

export default function LandingDemo() {
  const [t, setT] = useState(0)
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setT(PLAY_AT); return } // eslint-disable-line react-hooks/set-state-in-effect
    const id = setInterval(() => setT(x => (x + 1) % LOOP), TICK)
    return () => clearInterval(id)
  }, [])
  const typed = t >= TYPE_END ? URL_TEXT : URL_TEXT.slice(0, Math.ceil((URL_TEXT.length * t) / TYPE_END))
  const done = t >= LEADS_AT
  return (
    <div className="lp-demo" data-testid="landing-demo" data-step={t >= PLAY_AT ? 'live' : done ? 'leads' : t >= TYPE_END ? 'checks' : 'typing'} aria-label="Illustrative example of a dazl run, with made-up companies and people: a website in, checks, leads found, a Play that runs weekly">
      <div className="text-xs font-medium text-[var(--ink-3)] mb-2 text-center" data-testid="demo-label">Illustrative example · made-up companies and people</div>
      <div className="lp-card p-4 sm:p-5">
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
          <span className="pill pill-mint">Every lead quoted and linked</span>
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
                  <div className="text-sm text-[var(--ink-2)] mt-1">{l.quote} <span className="text-[var(--ink-3)] whitespace-nowrap">· {l.date}</span></div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className={`lp-card mt-3 p-4 flex items-center justify-between gap-3 lp-fade ${t >= PLAY_AT ? 'lp-in' : ''}`} data-testid="demo-play">
        <div className="min-w-0"><div className="font-semibold">Dental practices opening a new location</div><div className="text-sm text-[var(--ink-2)]">Ohio · hiring or expansion news</div></div>
        <span className="live-dot shrink-0">Live · runs weekly</span>
      </div>
    </div>
  )
}
