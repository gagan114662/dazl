'use client'
import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { dayOf, savedPlays, type MonitorRow, type SavedPlay, type WatchRow } from '@/lib/saved-plays'
import type { PlayRun, PlayRuns } from '@/lib/play-runs'
import type { PlayNew } from '@/lib/play-now'
import { newLabel, readSeen, runEnded, runNowMessage, RUN_POLL_MAX, RUN_POLL_MS, writeSeen, type RunNowAnswer } from '@/lib/play-new-view'
import { runNewLabel } from '@/lib/run-new-label'
import { Icon } from '../ui/icons'
import { Pill, type Tone } from '../ui/bits'

// Plays: the searches you saved to repeat, with who each looks for, the signal, schedule, last and next run (to the
// minute), status and pause/resume/delete. Results stay in Leads: each play links to its last run there and lists all its
// runs (#351). Reads GET /api/watch and GET /api/monitors; Pause, Resume and Delete are those routes' existing actions.
// #1042: each live play has "Find leads now" (POST /api/plays/[kind]/[id]/run: pulls its next scheduled run forward, on
// the account's own key and monthly scans) and says how many new leads it found since you last checked
// (GET /api/plays/[kind]/[id]/new), with a list of them and "Mark as seen". Nothing here sends anything to anyone.
const TONE: Record<SavedPlay['status']['tone'], Tone> = { live: 'mint', running: 'peach', paused: 'grey', failed: 'pink' }
type Read<T> = T[] | null | 'failed'
const store = () => { try { return typeof window === 'undefined' ? null : window.localStorage } catch { return null } }
const keyOf = (p: { kind: string; id: string }) => `${p.kind}-${p.id}`
type Fresh = PlayNew & { checked: boolean }

export default function PlaysClient() {
  const [watches, setWatches] = useState<Read<WatchRow>>(null)
  const [monitors, setMonitors] = useState<Read<MonitorRow>>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState('')
  // #351: a play's runs, read when its "Show runs" is opened (null while loading, 'failed' when the read did not answer).
  const [runs, setRuns] = useState<Record<string, PlayRuns | null | 'failed'>>({})
  // #1042: per play, what it found since this browser last marked it seen; which "What's new" lists are open; and the
  // answer to the last "Find leads now"
  const [fresh, setFresh] = useState<Record<string, Fresh | 'failed'>>({})
  const [openNew, setOpenNew] = useState<Record<string, boolean>>({})
  const [ran, setRan] = useState<Record<string, { ok: boolean; text: string }>>({})
  async function toggleRuns(p: SavedPlay) {
    const k = keyOf(p)
    if (k in runs) { setRuns(r => { const rest = { ...r }; delete rest[k]; return rest }); return }
    setRuns(r => ({ ...r, [k]: null }))
    const j = await fetch(`/api/plays/${p.kind}/${p.id}/runs`).then(r => r.ok ? r.json() : null).catch(() => null)
    // only into a list that is still open and still loading: one hidden meanwhile stays hidden
    setRuns(r => k in r && r[k] === null ? { ...r, [k]: Array.isArray(j?.runs) ? { runs: j.runs as PlayRun[], more: j.more === true } : 'failed' } : r)
  }
  async function loadNew(p: { kind: string; id: string }) {
    const since = readSeen(store(), p.kind, p.id)
    const j = await fetch(`/api/plays/${p.kind}/${p.id}/new?since=${since}`).then(r => r.ok ? r.json() : null).catch(() => null)
    const ok = !!j && typeof j.total === 'number' && Array.isArray(j.items)
    setFresh(f => ({ ...f, [keyOf(p)]: ok ? { ...(j as PlayNew), checked: since > 0 } : 'failed' }))
  }
  const get = <T,>(url: string, key: string) => fetch(url).then(r => r.ok ? r.json() : null).catch(() => null).then(j => ({ rows: Array.isArray(j?.[key]) ? j[key] as T[] : 'failed' as const, emails: j?.emails === true }))
  // whether this host sends the new-leads email after a run (GET /api/watch), so a play never promises one it cannot send
  const [emails, setEmails] = useState(false)
  const load = () => {
    void get<WatchRow>('/api/watch', 'watches').then(({ rows: w, emails: e }) => { setWatches(w); setEmails(e); if (Array.isArray(w)) for (const x of w) void loadNew({ kind: 'watch', id: x.id }) })
    void get<MonitorRow>('/api/monitors', 'monitors').then(({ rows: m }) => { setMonitors(m); if (Array.isArray(m)) for (const x of m) void loadNew({ kind: 'monitor', id: x.id }) })
  }
  // #1042: the started runs this page is following (one timer each), stopped when the page goes away
  const polls = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const alive = useRef(true)
  const loadOnMount = useRef(load)
  useEffect(() => {
    alive.current = true
    loadOnMount.current()
    const timers = polls.current
    return () => { alive.current = false; for (const t of timers.values()) clearTimeout(t); timers.clear() }
  }, [])
  // Follows one started run with the read-only status read until it ends (bounded), then reloads the play and its new
  // leads, so "the new leads show here when this run finishes" holds while the page stays open.
  function follow(jobId: string, tries = 0) {
    if (!alive.current) return
    const prev = polls.current.get(jobId); if (prev) clearTimeout(prev)
    polls.current.set(jobId, setTimeout(async () => {
      polls.current.delete(jobId)
      if (!alive.current) return
      const r = await fetch(`/api/scan/status?job_id=${jobId}&readonly=1`).catch(() => null)
      const j = r ? await r.json().catch(() => null) : null
      if (!alive.current) return
      if (r && runEnded(r.status, j)) { load(); return }
      if (tries + 1 < RUN_POLL_MAX) follow(jobId, tries + 1); else load()
    }, RUN_POLL_MS))
  }

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

  // #1042: one request; the answer is one sentence under the play (lib/play-new-view.ts runNowMessage), never a raw code
  async function runNow(p: SavedPlay) {
    const k = keyOf(p)
    setBusy(p.id); setRan(r => { const rest = { ...r }; delete rest[k]; return rest })
    const r = await fetch(`/api/plays/${p.kind}/${p.id}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => null)
    const j = r ? await r.json().catch(() => null) as RunNowAnswer : null
    setRan(x => ({ ...x, [k]: runNowMessage(r?.status ?? 0, j) }))
    setBusy(null)
    if (r?.status === 202 && j && 'job_id' in j && /^[0-9a-f]{24}$/.test(j.job_id)) {
      // the route already dispatched the scan; follow it so the page shows its new leads when it ends
      follow(j.job_id)
      load()
    }
  }

  function markSeen(p: SavedPlay) {
    const f = fresh[keyOf(p)]
    // seen_through: the newest time EVERY listed item is covered up to (lib/play-now.ts); null when nothing can be marked
    if (!f || f === 'failed' || f.seen_through === null) return
    writeSeen(store(), p.kind, p.id, f.seen_through)
    setOpenNew(o => ({ ...o, [keyOf(p)]: false }))
    void loadNew(p)
  }

  const loading = watches === null || monitors === null
  const plays = loading ? null : savedPlays(watches === 'failed' ? null : watches, monitors === 'failed' ? null : monitors, undefined, undefined, emails)
  const partFailed = watches === 'failed' || monitors === 'failed'
  return (
    <div className="p-4 sm:p-8 max-w-5xl">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-6">
        <div className="min-w-0">
          <h1 className="text-3xl font-bold tracking-tight">Plays</h1>
          <p className="text-[var(--ink-2)] text-sm mt-1" data-testid="plays-intro">Searches that run again on their schedule and keep finding new leads. Nothing is sent to anyone without your OK. Every run&apos;s leads are in <Link className="underline" href="/app/leads?latest=1">Leads</Link>.</p>
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
            <p className="text-[var(--ink-2)] mt-1">Run your first search in Leads. When it finishes, dazl sets it to repeat once a week by itself and shows only companies you have not seen. You can also choose <b>Watch this weekly</b> on any search.</p>
            <Link href="/app/leads" className="btn-ghost btn-sm mt-3 inline-flex">Start a play</Link>
          </div>
        ) : (
          <div className="grid gap-3">
            {plays.map(p => {
              const k = keyOf(p), f = fresh[k], nf = f && f !== 'failed' ? f : null, answer = ran[k], hasNew = !!nf && nf.total > 0
              return (
                <article key={k} className="card p-4 sm:p-5 min-w-0" data-testid="saved-play" data-kind={p.kind} data-active={p.active ? 'true' : 'false'}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    {/* The title keeps at least 15rem; a long status wraps below it on a phone. */}
                    <div className="min-w-0 flex-1 basis-60">
                      <h2 className="font-bold text-lg leading-tight break-words" data-testid="play-name">{p.name}</h2>
                      <p className="text-sm text-[var(--ink-2)] mt-0.5 break-words" data-testid="play-sentence">{p.sentence}</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {nf && hasNew && <Pill tone="mint" testid="play-new-count">{newLabel(nf.total, nf.checked)}</Pill>}
                      <Pill tone={TONE[p.status.tone]} testid="play-status">{p.status.label}</Pill>
                    </div>
                  </div>
                  <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-x-4 gap-y-2 mt-4 text-sm">
                    {([['Audience', p.audience ?? 'From the sentence above', 'audience'], ['Signal', p.signal ?? 'From the sentence above', 'signal'], ['Schedule', p.schedule, 'schedule'], ['Last run', p.lastRun, 'last-run'], ['Next run', p.nextRun, 'next-run']] as const).map(([label, v, id]) => (
                      <div key={label} className="min-w-0" data-testid={`play-${id}`}><dt className="text-[10px] uppercase tracking-wide text-[var(--ink-3)]">{label}</dt><dd className="break-words">{v}</dd></div>
                    ))}
                  </dl>
                  {p.note && <p className="text-xs text-[var(--ink-2)] mt-3" data-testid="play-note">{p.note}</p>}
                  <div className="flex flex-wrap gap-2 mt-4">
                    {/* a paused play never runs: Resume first (the route refuses it too) */}
                    {p.active && <button type="button" className="btn-primary btn-sm" disabled={busy === p.id} onClick={() => void runNow(p)} data-testid="play-run-now">{busy === p.id ? 'Starting...' : 'Find leads now'}</button>}
                    {hasNew && <button type="button" className="btn-ghost btn-sm" onClick={() => setOpenNew(o => ({ ...o, [k]: !o[k] }))} aria-expanded={!!openNew[k]} data-testid="play-new-toggle">{openNew[k] ? "Hide what's new" : "What's new"}</button>}
                    {p.lastHref && <Link href={p.lastHref} className="btn-ghost btn-sm" data-testid="play-results">See the last run&apos;s leads</Link>}
                    <button type="button" className="btn-ghost btn-sm" onClick={() => void toggleRuns(p)} aria-expanded={k in runs} data-testid="play-runs-toggle">{k in runs ? 'Hide runs' : 'Show runs'}</button>
                    <button type="button" className="btn-ghost btn-sm" disabled={busy === p.id} onClick={() => void act(p, p.active ? 'pause' : 'resume')} data-testid="play-toggle">{p.active ? 'Pause' : 'Resume'}</button>
                    <button type="button" className="btn-ghost btn-sm" disabled={busy === p.id} onClick={() => void act(p, 'delete')} data-testid="play-delete">Delete</button>
                  </div>
                  {answer && <p className={`text-sm mt-3 ${answer.ok ? '' : 'text-[#a3173f]'}`} role={answer.ok ? 'status' : 'alert'} data-testid="play-run-now-result">{answer.text}{!answer.ok && answer.text.includes('Settings') && <> <Link className="underline" href="/app/settings">Open Settings</Link></>}</p>}
                  {f === 'failed' && <p className="text-xs text-[var(--ink-3)] mt-3" data-testid="play-new-failed">Could not check this play for new leads. Refresh to retry.</p>}
                  {nf && nf.total === 0 && <p className="text-xs text-[var(--ink-3)] mt-3" data-testid="play-new-none">{newLabel(0, nf.checked)}</p>}
                  {openNew[k] && nf && <NewList data={nf} kind={p.kind} onSeen={() => markSeen(p)} />}
                  {k in runs && <PlayRunList runs={runs[k]} active={p.active} kind={p.kind} />}
                </article>
              )
            })}
          </div>
        )}
      <p className="text-xs text-[var(--ink-3)] mt-6">Each run, scheduled or started with Find leads now, is a real scan. On your own AI key it counts toward your monthly scans; your first play&apos;s weekly repeat can use your free searches while you have some left. Find leads now moves the next scheduled run earlier; it does not add one. One-off searches are in <Link className="underline" href="/app/leads?latest=1">Leads</Link>; each search&apos;s funnel is in <Link className="underline" href="/app/campaigns">Campaigns</Link>.</p>
    </div>
  )
}

// #1042: what a play found since it was last marked seen, newest run first; each opens that run's leads in Leads (where
// a weekly play's new leads carry a "new" tag).
function NewList({ data, kind, onSeen }: { data: Fresh; kind: 'watch' | 'monitor'; onSeen: () => void }) {
  return (
    <div className="mt-3 border-t border-[var(--line)] pt-3" data-testid="play-new-list">
      <ol className="divide-y divide-[var(--line)] text-sm">
        {data.items.map((it, i) => (
          <li key={`${it.job_id}-${i}`} className="flex flex-wrap items-center justify-between gap-2 py-2 min-w-0" data-testid="play-new-item">
            <span className="min-w-0 break-words"><Pill tone="mint">new</Pill> <b>{it.company || 'Unnamed company'}</b>{it.what ? ` · ${it.what}` : ''} <span className="text-[var(--ink-3)]">· {dayOf(it.at)}</span></span>
            <Link href={`/app/leads?job_id=${it.job_id}`} className="underline underline-offset-2 shrink-0" data-testid="play-new-link">Open in Leads</Link>
          </li>
        ))}
      </ol>
      {data.truncated && <p className="text-xs text-[var(--ink-3)] mt-2" data-testid="play-new-more">{data.seen_through !== null
        ? `Showing the first ${data.items.length} of ${data.total}${kind === 'monitor' ? ' alerts' : ''}. Mark these as seen to see the rest.`
        : `There are ${data.total}${kind === 'monitor' ? ' alerts' : ' new leads'} from one run. Open it in Leads to see them all.`}</p>}
      {data.seen_through !== null && <button type="button" className="btn-ghost btn-sm mt-2" onClick={onSeen} data-testid="play-new-seen">{data.truncated ? 'Mark these as seen' : 'Mark as seen'}</button>}
    </div>
  )
}

// #351: a play's latest runs, newest first; each opens that run's own leads. Says when older runs exist.
const RUN_STATUS: Record<string, string> = { done: 'Finished', failed: 'Failed', pending: 'Queued', running: 'Running', enriching: 'Finishing' }
function PlayRunList({ runs: r, active, kind }: { runs: PlayRuns | null | 'failed'; active: boolean; kind: 'watch' | 'monitor' }) {
  if (r === null) return <p className="text-sm text-[var(--ink-2)] mt-3">Loading runs...</p>
  if (r === 'failed') return <p className="text-sm mt-3" role="alert" data-testid="play-runs-failed">Could not load this play&apos;s runs. Try again.</p>
  if (r.runs.length === 0) return <p className="text-sm text-[var(--ink-2)] mt-3" data-testid="play-runs-empty">{active ? 'No runs yet. The first runs on its next scheduled date.' : 'No runs yet. It is paused: resume it to run.'}</p>
  return (
    <>
      <ol className="mt-3 divide-y divide-[var(--line)] border-t border-[var(--line)] text-sm" data-testid="play-runs">
        {r.runs.map(run => (
          <li key={run.job_id} className="flex flex-wrap items-center justify-between gap-2 py-2 min-w-0" data-testid="play-run">
            <span className="min-w-0">{dayOf(run.at)} · {RUN_STATUS[run.status] ?? run.status} · {run.leads} lead{run.leads === 1 ? '' : 's'}{run.new_leads !== null ? `, ${runNewLabel(kind, run.new_leads)}` : ''}</span>
            <Link href={`/app/leads?job_id=${run.job_id}`} className="underline underline-offset-2 shrink-0" data-testid="play-run-link">Open these leads</Link>
          </li>
        ))}
      </ol>
      {r.more && <p className="text-xs text-[var(--ink-3)] mt-2" data-testid="play-runs-more">Showing the latest {r.runs.length} runs.</p>}
    </>
  )
}
