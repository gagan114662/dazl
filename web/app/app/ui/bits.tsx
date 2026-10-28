'use client'

// Company avatar: initials in a soft circle. (Favicons would need the CSP's img-src to allow company sites, which is
// a security-policy change outside this UI; until then nothing third-party is loaded.)
export function Avatar({ name, size = 40 }: { name: string; size?: number }) {
  const initials = name.replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]!.toUpperCase()).join('') || '?'
  return <span className="inline-flex items-center justify-center rounded-full shrink-0 font-semibold tracking-wide text-[var(--ink)] bg-[#f1ebe5]" style={{ width: size, height: size, fontSize: size * 0.32 }} aria-hidden data-testid="avatar">{initials}</span>
}

export type Tone = 'mint' | 'peach' | 'pink' | 'lav' | 'plain' | 'grey'
export function Pill({ tone = 'grey', children, testid }: { tone?: Tone; children: React.ReactNode; testid?: string }) {
  return <span className={`pill ${tone === 'grey' ? '' : `pill-${tone}`}`} data-testid={testid}>{children}</span>
}

// Live progress for a scan, one bordered row per stage with its state on the right ("Done", "Searching..."), from the
// status the server reports (no invented progress).
export interface Step { label: string; state: 'done' | 'live' | 'todo'; note?: string }
const STATE = { done: 'Done', live: 'Working...', todo: 'Waiting' } as const
export function Stepper({ steps }: { steps: Step[] }) {
  return (
    <ol className="flex flex-col gap-2" data-testid="scan-stepper">
      {steps.map(s => (
        <li key={s.label} className={`row-box flex items-center gap-3 px-3.5 py-2.5 text-sm ${s.state === 'todo' ? 'opacity-55' : ''}`} data-state={s.state}>
          <span aria-hidden className={`step-dot ${s.state === 'done' ? 'bg-[var(--mint-bg)] text-[var(--live)]' : s.state === 'live' ? 'bg-[var(--lav-bg)] text-[var(--lav)] step-live' : 'bg-[#f3eeea] text-[var(--ink-3)]'}`}>{s.state === 'done' ? '✓' : '•'}</span>
          <span className="font-medium min-w-0 truncate">{s.label}</span>
          <span className={`ml-auto text-xs whitespace-nowrap ${s.state === 'live' ? 'text-[var(--ink)] step-live' : 'text-[var(--ink-3)]'}`}>{s.note ?? STATE[s.state]}</span>
        </li>
      ))}
    </ol>
  )
}
