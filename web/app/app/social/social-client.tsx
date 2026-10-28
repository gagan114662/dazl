'use client'
import { useEffect, useState } from 'react'
import ThreadMetrics from './thread-metrics'
import { Pill } from '../ui/bits'

const STATUS = { draft: 'Draft ready', edited: 'Edited', copied: 'Copied', posted: 'Posted by you' } as const

type Thread = {
  id: string; platform: 'reddit' | 'x'; url: string; title: string; quote: string; query: string
  date: string | null; created_at: number; buyer_intent?: string | null
  draft: string | null; draft_status: 'draft' | 'edited' | 'copied' | 'posted' | null
}
type State = { queries: string[]; threads: Thread[]; platforms: { reddit: boolean; x: boolean }; consent: boolean; has_key: boolean }

const without = (o: Record<string, string>, k: string) => { const c = { ...o }; delete c[k]; return c }

export default function SocialClient() {
  const [state, setState] = useState<State | null>(null)
  const [newQuery, setNewQuery] = useState('')
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const [copied, setCopied] = useState('')
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [editing, setEditing] = useState<string | null>(null)
  const [cardErr, setCardErr] = useState<Record<string, string>>({})

  async function load() { const r = await fetch('/api/replies'); if (r.ok) setState(await r.json()) }
  useEffect(() => { void load() }, [])

  async function post(body: Record<string, unknown>, url = '/api/replies') {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(j.error || 'Request failed')
    return j
  }

  async function saveQueries(queries: string[]) {
    setMsg('')
    try { await post({ action: 'set_queries', queries }) } catch (e) { setMsg((e as Error).message) }
    void load()
  }
  async function addQuery() {
    const q = newQuery.trim()
    if (!q || !state) return
    setNewQuery('')
    await saveQueries([...state.queries, q])
  }
  async function refresh() {
    setBusy('refresh'); setMsg('')
    try {
      const j = await post({ action: 'refresh' })
      const parts = Object.entries((j.platforms ?? {}) as Record<string, string>).map(([p, s]) => `${p === 'x' ? 'X' : 'Reddit'}: ${s === 'ok' ? 'checked' : s.replaceAll('_', ' ')}`)
      const kept = `${j.added} new thread${j.added === 1 ? '' : 's'} found`
      const dropped = j.filtered > 0 ? `, ${j.filtered} off-topic result${j.filtered === 1 ? '' : 's'} filtered out` : ''
      const gradedPart = j.graded > 0 ? ` Buyer intent graded on your AI key: ${j.graded}.` : ''
      const backlog = (j.ungraded_remaining ?? 0) > 0 ? ` ${j.ungraded_remaining} older thread${j.ungraded_remaining === 1 ? ' is' : 's are'} still ungraded - check again to grade more.` : ''
      setMsg((j.added > 0 ? `${kept}${dropped}. ${parts.join(' - ')}` : `Nothing new${dropped}. ${parts.join(' - ')}`) + gradedPart + backlog)
    } catch (e) { setMsg((e as Error).message) }
    setBusy('')
    void load()
  }
  async function draft(id: string) {
    setBusy(id); setCardErr(c => ({ ...c, [id]: '' }))
    try {
      await post({ action: 'draft' }, `/api/replies/${id}`)
      setEdits(e => without(e, id)) // the editor shows the new server draft, not stale text
    } catch (e) { setCardErr(c => ({ ...c, [id]: (e as Error).message })) }
    setBusy('')
    void load()
  }
  // Save keeps the editor open until the server confirms; a failure is shown on that card, never above the list.
  async function saveEdit(id: string) {
    setCardErr(c => ({ ...c, [id]: '' }))
    try { await post({ action: 'save', draft: edits[id] ?? '' }, `/api/replies/${id}`) } catch (e) { setCardErr(c => ({ ...c, [id]: `Not saved: ${(e as Error).message}. Your text is still here; try Save again.` })); return }
    setEditing(null)
    setEdits(e => without(e, id))
    void load()
  }
  async function copyAndOpen(t: Thread) {
    const text = t.draft ?? '' // the server-confirmed draft, never unsaved editor text
    try { await navigator.clipboard.writeText(text) } catch { setMsg('Copy failed - select the text and copy it by hand.') }
    window.open(t.url, '_blank', 'noopener,noreferrer')
    setCopied(t.id); setTimeout(() => setCopied(''), 3000)
    try { await post({ action: 'mark', status: 'copied' }, `/api/replies/${t.id}`) } catch { /* status is a convenience, not a gate */ }
    void load()
  }
  async function markPosted(id: string) {
    try { await post({ action: 'mark', status: 'posted' }, `/api/replies/${id}`) } catch { /* ignore */ }
    void load()
  }
  async function dismiss(id: string) {
    try { await post({ action: 'dismiss', id }) } catch { /* ignore */ }
    void load()
  }

  if (!state) return <main className="p-6 md:p-10 max-w-4xl"><p className="text-[#555]">Loading...</p></main>
  const anyPlatform = state.platforms.reddit || state.platforms.x
  return (
    <main className="p-6 md:p-10 max-w-4xl">
      <h1 className="text-2xl font-semibold mb-1">Social opportunities</h1>
      <p className="text-[#555] text-sm mb-6">
        Fresh Reddit and X threads that mention your searches and look like questions. Not every match is your buyer - review each one and decide. Replies are drafted on your own AI key.
        dazl never posts: you review the reply, edit it, then copy it and post it yourself from your own account.
        Email replies to your outreach are in <a className="underline" href="/app/inbox">Inbox</a>.
      </p>

      {/* Nothing here can work until the operator enables Reddit or X, so only this notice is shown: no searches, no
          check button, no key prompt (threads saved earlier still appear below). */}
      {!anyPlatform && (
        <div className="card p-4 mb-6 text-sm" data-testid="social-coming-soon">
          <p className="font-medium">Coming soon on this workspace</p>
          <p className="text-[#555] mt-1">Reddit and X access is not enabled here, so dazl cannot look for threads yet. There is nothing for you to set up.</p>
        </div>
      )}
      {anyPlatform && !state.consent && (
        <div className="card p-4 mb-6 text-sm text-[#555]">Reddit/X collection needs your consent and your own session in <a className="underline" href="/app/settings">Settings</a> first. Nothing is collected until then.</div>
      )}
      {anyPlatform && !state.has_key && (
        <div className="card p-4 mb-6 text-sm text-[#555]">Reply drafts use your own AI key - add one in <a className="underline" href="/app/settings">Settings</a>.</div>
      )}

      {anyPlatform && <ThreadMetrics />}
      {anyPlatform && <div className="card p-6 mb-8">
        <h2 className="font-semibold mb-1">Searches</h2>
        <p className="text-[#555] text-sm mb-3">Up to 5 short searches for the questions your buyers ask, like &quot;outbound tool&quot; or &quot;cold email software&quot;.</p>
        <div className="flex gap-2 mb-3">
          <input className="field flex-1" value={newQuery} onChange={e => setNewQuery(e.target.value)} maxLength={100} placeholder="outbound tool" />
          <button className="btn-primary text-sm" disabled={!newQuery.trim()} onClick={addQuery}>Add</button>
        </div>
        {state.queries.map(q => (
          <span key={q} className="inline-flex items-center gap-2 text-xs border border-black/15 rounded-full px-3 py-1 mr-2 mb-2">
            {q}
            <button className="text-[#999] hover:text-[#111]" aria-label={`Remove search "${q}"`} title="Remove this search" onClick={() => saveQueries(state.queries.filter(x => x !== q))}>x</button>
          </span>
        ))}
        <div className="mt-3">
          <button className="btn-primary text-sm" disabled={busy === 'refresh' || state.queries.length === 0 || !anyPlatform || !state.consent} onClick={refresh}>
            {busy === 'refresh' ? 'Checking Reddit and X...' : 'Check for new threads'}
          </button>
          {state.has_key && (
            <p className="text-xs text-[#999] mt-2">Checking also grades matches for buyer intent on your AI key - up to 10 gradings per check, at your key&apos;s cost. Without a key, matches are keyword-only.</p>
          )}
        </div>
        {msg && <p className="text-sm text-[#555] mt-3">{msg}</p>}
      </div>}

      {state.threads.length === 0 ? (
        anyPlatform && <p className="text-sm text-[#999]">No threads yet. Add a search above and check for new threads.</p>
      ) : state.threads.map(t => (
        // One card per thread. One primary action, Approve: before a draft it writes one on your AI key; with a draft it
        // copies the reply and opens the thread so you post it yourself (dazl never posts). Edit draft and Reject beside it.
        <div key={t.id} className="card p-5 sm:p-6 mb-4" data-testid="thread-card">
          <div className="flex flex-wrap items-center gap-2 mb-2 text-xs">
            <Pill tone="plain">{t.platform === 'x' ? 'X' : 'Reddit'}</Pill>
            {t.date && <span className="text-[var(--ink-3)]">{t.date}</span>}
            <span className="text-[var(--ink-3)]">found by &quot;{t.query}&quot;</span>
            {t.buyer_intent === 'yes' && <span className="text-[var(--ink-3)]">buyer intent: model-graded - heuristic, review yourself</span>}
            {t.buyer_intent === 'uncertain' && <span className="text-[var(--ink-3)]">buyer intent: unverified</span>}
            {t.draft_status && <span className="ml-auto" data-testid="draft-status"><Pill tone={t.draft_status === 'posted' ? 'mint' : 'plain'}>{STATUS[t.draft_status]}</Pill></span>}
          </div>
          <a className="font-semibold text-base hover:underline break-words" href={t.url} target="_blank" rel="noopener noreferrer">{t.title}</a>
          <p className="text-sm text-[var(--ink-2)] mt-1 break-words">{t.quote}</p>
          {t.draft !== null && (editing === t.id
            ? <div className="mt-3">
              <textarea className="field w-full text-sm" rows={5} aria-label="Your reply" value={edits[t.id] ?? t.draft} onChange={e => setEdits({ ...edits, [t.id]: e.target.value })} maxLength={4000} autoFocus />
              <div className="flex flex-wrap items-center gap-2 mt-2">
                <button className="btn-ghost btn-sm" onClick={() => saveEdit(t.id)}>Save</button>
                <button className="btn-ghost btn-sm" onClick={() => { setEdits(e => without(e, t.id)); setCardErr(c => ({ ...c, [t.id]: '' })); setEditing(null) }}>Cancel</button>
                <button className="text-xs underline text-[var(--ink-2)] ml-auto" disabled={busy === t.id || !state.has_key} onClick={() => draft(t.id)}>{busy === t.id ? 'Drafting...' : 'Write a new draft on your AI key'}</button>
              </div>
            </div>
            : <p className="mt-3 text-sm whitespace-pre-wrap break-words rounded-[10px] bg-[#f8f4f0] px-3 py-2.5" data-testid="draft-text">{t.draft}</p>)}
          {cardErr[t.id] && <p role="alert" className="mt-2 text-xs font-medium text-[#a3173f]" data-testid="card-error">{cardErr[t.id]}</p>}
          <div className="mt-3" data-testid="thread-actions">
            {editing !== t.id && <div className="flex flex-wrap items-center gap-2">
              {t.draft === null
                ? <button className="btn-primary btn-sm" disabled={busy === t.id || !state.has_key} onClick={() => draft(t.id)}>{busy === t.id ? 'Drafting...' : 'Approve'}</button>
                : <button className="btn-primary btn-sm" onClick={() => copyAndOpen(t)}>{copied === t.id ? 'Copied - paste it in the thread' : 'Approve'}</button>}
              {t.draft !== null && <button className="btn-ghost btn-sm" onClick={() => setEditing(t.id)}>Edit draft</button>}
              <button className="btn-ghost btn-sm" onClick={() => dismiss(t.id)}>Reject</button>
              {t.draft !== null && t.draft_status !== 'posted' && <button className="text-xs underline text-[var(--ink-2)] ml-auto" onClick={() => markPosted(t.id)}>I posted it</button>}
            </div>}
            <p className="text-xs text-[var(--ink-2)] mt-2" data-testid="action-hint">{t.draft === null
              ? state.has_key ? 'Approve writes a suggested reply on your AI key for you to check. Nothing is posted. Reject hides this thread.'
                : 'Approve needs your AI key to write the reply (add one in Settings). Reject hides this thread.'
              : 'dazl never posts. Approve copies your reply and opens the thread so you post it from your own account. Reject hides this thread.'}</p>
          </div>
        </div>
      ))}
    </main>
  )
}
