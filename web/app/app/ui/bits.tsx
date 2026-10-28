'use client'

// Company avatar: initials on a pastel tile. (Favicons would need the CSP's img-src to allow company sites, which is
// a security-policy change outside this UI; until then nothing third-party is loaded.)
const HUES = ['var(--peach-bg)', 'var(--pink-bg)', 'var(--lav-bg)', 'var(--mint-bg)']
export function Avatar({ name, size = 40 }: { name: string; size?: number }) {
  const initials = name.replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]!.toUpperCase()).join('') || '?'
  const hue = HUES[[...name].reduce((n, c) => n + c.charCodeAt(0), 0) % HUES.length]
  return <span className="inline-flex items-center justify-center rounded-xl shrink-0 font-bold text-[var(--ink)]" style={{ width: size, height: size, background: hue, fontSize: size * 0.36 }} aria-hidden data-testid="avatar">{initials}</span>
}

export type Tone = 'mint' | 'peach' | 'pink' | 'lav' | 'plain' | 'grey'
export function Pill({ tone = 'grey', children, testid }: { tone?: Tone; children: React.ReactNode; testid?: string }) {
  return <span className={`pill ${tone === 'grey' ? '' : `pill-${tone}`}`} data-testid={testid}>{children}</span>
}

// Live stepper for a scan: what the scan is doing now, from the status the server reports (no invented progress).
export interface Step { label: string; state: 'done' | 'live' | 'todo'; note?: string }
export function Stepper({ steps }: { steps: Step[] }) {
  return (
    <ol className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-2" data-testid="scan-stepper">
      {steps.map((s, i) => (
        <li key={s.label} className="flex items-center gap-2 sm:flex-1 min-w-0" data-state={s.state}>
          <span className={`step-dot ${s.state === 'done' ? 'bg-[var(--mint)] text-white' : s.state === 'live' ? 'bg-[var(--lav)] text-white step-live' : 'bg-[#f1e9ec] text-[var(--ink-3)]'}`}>{s.state === 'done' ? '✓' : i + 1}</span>
          <span className="min-w-0">
            <span className={`block text-sm font-semibold ${s.state === 'todo' ? 'text-[var(--ink-3)]' : ''}`}>{s.label}</span>
            {s.note && <span className="block text-xs text-[var(--ink-2)] truncate">{s.note}</span>}
          </span>
          {i < steps.length - 1 && <span aria-hidden className="hidden sm:block flex-1 h-px bg-[var(--line-2)] mx-1" />}
        </li>
      ))}
    </ol>
  )
}
