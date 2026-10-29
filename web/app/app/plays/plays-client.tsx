'use client'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { savedPlays, type MonitorRow, type SavedPlay, type WatchRow } from '@/lib/saved-plays'
import { Icon } from '../ui/icons'
import { Pill, type Tone } from '../ui/bits'

// Plays: the searches you saved to repeat, with who each looks for, the signal, schedule, last and next run, status and
// pause/resume/delete. Results stay in Leads (each play links to its last run there). Reads GET /api/watch and
// GET /api/monitors; Pause, Resume and Delete are those routes' existing actions. Nothing here starts a scan.
const TONE: Record<SavedPlay['status']['tone'], Tone> = { live: 'mint', running: 'peach', paused: 'grey', failed: 'pink' }
type Read<T> = T[] | null | 'failed'

export default function PlaysClient() {
  const [watches, setWatches] = useState<Read<WatchRow>>(null)
  const [monitors, setMonitors] = useState<Read<MonitorRow>>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const get = <T,>(url: string, key: string) => fetch(url).then(r => r.ok ? r.json() : null).catch(() => null).then(j => Array.isArray(j?.[key]) ? j[key] as T[] : 'failed' as const)
  const load = () => { void get<WatchRow>('/api/watch', 'watches').then(setWatches); void get<MonitorRow>('/api/monitors', 'monitors').then(setMonitors) }
  useEffect(load, [])

  async function act(p: SavedPlay, action: 'pause' | 'resume' | 'delete') {
    if (action === 'delete' && !window.confirm(`Delete "${p.name}"? Its past runs stay in Leads; it stops repeating.`)) return
    setBusy(p.id); setErr('')
    const json = { 'content-type': 'application/json' }
    const r = await (p.kind === 'watch'
      ? fetch('/api/watch', { method: 'POST', headers: json, body: JSON.stringify({ action, id: p.id }) })
      : action === 'delete' ? fetch(`/api/monitors/${p.id}`, { method: 'DELETE' })
      : fetch(`/api/monitors/${p.id}`, { method: 'PATCH', headers: json, body: JSON.stringify({ enabled: action === 'resume' }) })).catch(() => null)
    const j = r ? await r.json().catch(() => null) : null
    if (!r?.ok || j?.error) setErr(j?.error || 'Could not update that play. Try again.')
    setBusy(null); load()
  }

  const loading = watches === null || monitors === null
  const plays = loading ? null : savedPlays(watches === 'failed' ? null : watches, monitors === 'failed' ? null : monitors)
  const partFailed = watches === 'failed' || monitors === 'failed'
  return (
    <div className="p-4 sm:p-8 max-w-5xl">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-6">
        <div className="min-w-0">
          <h1 className="text-3xl font-bold tracking-tight">Plays</h1>
          <p className="text-[var(--ink-2)] text-sm mt-1">Searches you saved to repeat on a schedule. What each run finds is in <Link className="underline" href="/app/leads?latest=1">Leads</Link>.</p>
        </div>
        <Link href="/app/leads" className="btn-primary btn-sm shrink-0" data-testid="new-play"><Icon name="plays" className="w-4 h-4" />New play</Link>
      </div>
      {err && <p className="text-sm mb-4 text-[#a3173f]" role="alert" data-testid="plays-error">{err}</p>}
      {/* A list that did not load is never shown as "no plays": the rest is shown with what could not be read. */}
      {partFailed && <p className="text-sm mb-4" role="alert" data-testid="plays-unavailable">Could not load {watches === 'failed' && monitors === 'failed' ? 'your saved plays' : watches === 'failed' ? 'your weekly plays' : 'your scheduled monitors'}. Refresh to retry.</p>}
      {plays === null ? <p className="text-sm text-[var(--ink-2)]">Loading your plays...</p>
        : plays.length === 0 && !partFailed ? (
          <div className="card p-6 text-sm" data-testid="plays-empty">
            <p className="font-semibold">No saved plays yet</p>
            <p className="text-[var(--ink-2)] mt-1">Run a search, then choose <b>Watch this weekly</b> to repeat it. dazl re-runs it once a week and shows only companies you have not seen. Each run counts toward your monthly scans.</p>
            <Link href="/app/leads" className="btn-ghost btn-sm mt-3 inline-flex">Start a play</Link>
          </div>
        ) : (
          <div className="grid gap-3">
            {plays.map(p => (
              <article key={`${p.kind}-${p.id}`} className="card p-4 sm:p-5 min-w-0" data-testid="saved-play" data-kind={p.kind} data-active={p.active ? 'true' : 'false'}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  {/* The title keeps at least 15rem; a long status wraps below it on a phone. */}
                  <div className="min-w-0 flex-1 basis-60">
                    <h2 className="font-bold text-lg leading-tight break-words" data-testid="play-name">{p.name}</h2>
                    <p className="text-sm text-[var(--ink-2)] mt-0.5 break-words" data-testid="play-sentence">{p.sentence}</p>
                  </div>
                  <Pill tone={TONE[p.status.tone]} testid="play-status">{p.status.label}</Pill>
                </div>
                <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-x-4 gap-y-2 mt-4 text-sm">
                  {([['Audience', p.audience ?? 'From the sentence above', 'audience'], ['Signal', p.signal ?? 'From the sentence above', 'signal'], ['Schedule', p.schedule, 'schedule'], ['Last run', p.lastRun, 'last-run'], ['Next run', p.nextRun, 'next-run']] as const).map(([k, v, id]) => (
                    <div key={k} className="min-w-0" data-testid={`play-${id}`}><dt className="text-[10px] uppercase tracking-wide text-[var(--ink-3)]">{k}</dt><dd className="break-words">{v}</dd></div>
                  ))}
                </dl>
                <div className="flex flex-wrap gap-2 mt-4">
                  {p.lastHref && <Link href={p.lastHref} className="btn-ghost btn-sm" data-testid="play-results">See the last run&apos;s leads</Link>}
                  <button type="button" className="btn-ghost btn-sm" disabled={busy === p.id} onClick={() => void act(p, p.active ? 'pause' : 'resume')} data-testid="play-toggle">{p.active ? 'Pause' : 'Resume'}</button>
                  <button type="button" className="btn-ghost btn-sm" disabled={busy === p.id} onClick={() => void act(p, 'delete')} data-testid="play-delete">Delete</button>
                </div>
              </article>
            ))}
          </div>
        )}
      <p className="text-xs text-[var(--ink-3)] mt-6">Each scheduled run is a real scan and counts toward your monthly scans. One-off searches are in <Link className="underline" href="/app/leads?latest=1">Leads</Link>; each search&apos;s funnel is in <Link className="underline" href="/app/campaigns">Campaigns</Link>.</p>
    </div>
  )
}
