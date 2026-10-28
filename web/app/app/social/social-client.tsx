'use client'
import { useEffect, useState } from 'react'
import ThreadMetrics from './thread-metrics'

type Thread = {
  id: string; platform: 'reddit' | 'x'; url: string; title: string; quote: string; query: string
  date: string | null; created_at: number; buyer_intent?: string | null
  draft: string | null; draft_status: 'draft' | 'edited' | 'copied' | 'posted' | null
}
type State = { queries: string[]; threads: Thread[]; platforms: { reddit: boolean; x: boolean }; consent: boolean; has_key: boolean }

export default function SocialClient() {
  const [state, setState] = useState<State | null>(null)
  const [newQuery, setNewQuery] = useState('')
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const [copied, setCopied] = useState('')
  const [edits, setEdits] = useState<Record<string, string>>({})

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
    setBusy(id); setMsg('')
    try { await post({ action: 'draft' }, `/api/replies/${id}`) } catch (e) { setMsg((e as Error).message) }
    setBusy('')
    void load()
  }
  async function saveEdit(id: string) {
    try { await post({ action: 'save', draft: edits[id] ?? '' }, `/api/replies/${id}`) } catch (e) { setMsg((e as Error).message) }
    void load()
  }
  async function copyAndOpen(t: Thread) {
    const text = edits[t.id] ?? t.draft ?? ''
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
        <div key={t.id} className="card p-6 mb-4">
          <div className="flex items-center gap-2 mb-1 text-xs">
            <span className="border border-black/15 rounded-full px-2 py-0.5">{t.platform === 'x' ? 'X' : 'Reddit'}</span>
            {t.date && <span className="text-[#999]">{t.date}</span>}
            <span className="text-[#999]">found by &quot;{t.query}&quot;</span>
            {t.buyer_intent === 'yes' && <span className="text-[#999]">buyer intent: model-graded - heuristic, review yourself</span>}
            {t.buyer_intent === 'uncertain' && <span className="text-[#999]">buyer intent: unverified</span>}
            {t.draft_status && <span className={t.draft_status === 'posted' ? 'text-green-700' : 'text-[#999]'}>{t.draft_status === 'posted' ? 'posted by you' : t.draft_status === 'copied' ? 'copied' : t.draft_status}</span>}
          </div>
          <a className="font-medium underline" href={t.url} target="_blank" rel="noopener noreferrer">{t.title}</a>
          <p className="text-sm text-[#555] mt-1">{t.quote}</p>
          <div className="mt-3" data-testid="thread-actions">
            {t.draft === null ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <button className="btn-primary text-sm" disabled={busy === t.id || !state.has_key} onClick={() => draft(t.id)}>
                    {busy === t.id ? 'Drafting...' : 'Draft reply'}
                  </button>
                  <button className="btn-ghost text-sm" onClick={() => dismiss(t.id)}>Dismiss</button>
                </div>
                <p className="text-xs text-[#555] mt-2" data-testid="action-hint">{state.has_key
                  ? 'Draft reply writes a suggested reply on your AI key for you to edit. Nothing is posted. Dismiss hides this thread.'
                  : 'Drafting needs your AI key (add one in Settings). Dismiss hides this thread.'}</p>
              </>
            ) : (
              <>
                <textarea
                  className="field w-full text-sm"
                  rows={4}
                  aria-label="Your reply"
                  value={edits[t.id] ?? t.draft}
                  onChange={e => setEdits({ ...edits, [t.id]: e.target.value })}
                  maxLength={4000}
                />
                <div className="flex flex-wrap items-center gap-2 mt-2">
                  <button className="btn-primary text-sm" onClick={() => copyAndOpen(t)}>{copied === t.id ? 'Copied - paste it in the thread' : 'Copy reply & open thread'}</button>
                  <button className="btn-ghost text-sm" onClick={() => saveEdit(t.id)}>Save edit</button>
                  <button className="btn-ghost text-sm" disabled={busy === t.id} onClick={() => draft(t.id)}>{busy === t.id ? 'Drafting...' : 'Redraft'}</button>
                  {t.draft_status !== 'posted' && <button className="btn-ghost text-sm" onClick={() => markPosted(t.id)}>Mark as posted</button>}
                  <button className="btn-ghost text-sm" onClick={() => dismiss(t.id)}>Dismiss</button>
                </div>
                <p className="text-xs text-[#555] mt-2" data-testid="action-hint">dazl never posts. Copy puts your reply on the clipboard and opens the thread so you can post it from your own account; Mark as posted only records that you did. Redraft replaces the text on your AI key.</p>
              </>
            )}
          </div>
        </div>
      ))}
    </main>
  )
}
