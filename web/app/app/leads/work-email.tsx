'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { guessCopy, mergeLookups, nameKey, workEmailCopy, workEmailCostNote, PENDING_POLL_MAX, PENDING_POLL_MS, type GuessShown, type ShownLookup } from '@/lib/people/work-email-eligible'

// #1036: "Find work email" for the buyer-role people on one lead (lib/people/work-email.ts runs the lookup on the server
// with the workspace's own Apollo / People Data Labs keys). Only a checked address (verified by the provider, printed on the
// company website, or confirmed by the free-tier mailbox check) is labelled checked; an unchecked one says so; nothing here drafts or sends.
// Rows from the server are MERGED by updated_at (mergeLookups): a slow first read never erases a newer result, and a
// lookup another tab has in flight ('pending') is re-read every PENDING_POLL_MS until it finishes or becomes retryable.
type Lookup = ShownLookup
type Providers = { apollo: boolean; pdl: boolean; pdlNeedsOptIn: boolean; mailboxCheck?: boolean }
export interface WorkEmailTarget { key: string; name: string; title: string | null }

// Keyed by lead: another lead's rows are never merged into this one's.
// lazy (#1036, the review lane): no request when the block mounts. A page can show many review rows; each would otherwise read
// the same providers and its own lookups on load. The first click reads what it needs (a stored result is replayed by the POST, free).
export default function WorkEmail(p: { leadId: string; targets: WorkEmailTarget[]; lazy?: boolean }) {
  return <WorkEmailFor key={p.leadId} {...p} />
}

function WorkEmailFor({ leadId, targets, lazy }: { leadId: string; targets: WorkEmailTarget[]; lazy?: boolean }) {
  const [lookups, setLookups] = useState<Record<string, Lookup>>({})
  const [providers, setProviders] = useState<Providers | null>(null)
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [msg, setMsg] = useState<Record<string, string>>({})
  const [copied, setCopied] = useState('')
  // guessed addresses (learned format), by person: the GET read survives a reload, the POST answer shows at once
  const [guesses, setGuesses] = useState<Record<string, GuessShown>>({})
  const takeGuesses = useCallback((list: unknown) => { if (!Array.isArray(list)) return; setGuesses(g => { const n = { ...g }; for (const x of list) if (x && typeof x === 'object' && typeof (x as GuessShown).person === 'string' && typeof (x as GuessShown).address === 'string') n[nameKey((x as GuessShown).person)] = x as GuessShown; return n }) }, [])

  const [reads, setReads] = useState(0)
  const mounted = useRef(false)
  const load = useCallback(() => {
    fetch(`/api/leads/${leadId}/work-email`).then(async r => {
      if (!r.ok || !mounted.current) return
      const j = await r.json() as { providers?: Providers; lookups?: unknown; guesses?: unknown }
      if (!mounted.current) return
      if (j.providers) setProviders(j.providers)
      setLookups(ls => mergeLookups(ls, j.lookups))
      takeGuesses(j.guesses)
    }).catch(() => { /* the button still works; the cost line just stays generic */ })
  }, [leadId, takeGuesses])

  useEffect(() => {
    mounted.current = true
    if (!lazy) load()
    return () => { mounted.current = false }
  }, [load, lazy])

  // A lookup running elsewhere shows 'pending' (no button): re-read until it is finished or retryable, bounded.
  const waiting = Object.values(lookups).some(l => (l.status === 'pending' || l.mailbox_check === 'pending') && !busy[l.target])
  useEffect(() => {
    if (!waiting || reads >= PENDING_POLL_MAX) return
    const t = setTimeout(() => { setReads(n => n + 1); load() }, PENDING_POLL_MS)
    return () => clearTimeout(t)
  }, [waiting, reads, load])

  async function find(key: string) {
    if (busy[key]) return
    setBusy(b => ({ ...b, [key]: true })); setMsg(m => ({ ...m, [key]: '' }))
    let text = 'Could not run the lookup. Try again.'
    try {
      const r = await fetch(`/api/leads/${leadId}/work-email`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: key }) })
      const j = await r.json().catch(() => ({})) as { status?: string; lookup?: Lookup; detail?: string; error?: string; guess?: GuessShown }
      if (r.ok && j.guess) takeGuesses([j.guess])
      if (r.status === 409) { setReads(0); load() } // running in another tab: show it as pending and follow it
      if (r.ok && j.lookup) { const l = j.lookup; setLookups(ls => mergeLookups(ls, [l], true)); text = '' }
      else if (r.ok && j.status === 'no_key') text = 'The company website does not print an address for this person, and no Apollo or People Data Labs key is set to look further. Add your own key in Settings > Enrichment.'
      else if (j.error) text = String(j.error)
    } catch { /* keep the generic message */ }
    setMsg(m => ({ ...m, [key]: text })); setBusy(b => ({ ...b, [key]: false }))
  }

  async function copy(address: string) {
    try { await navigator.clipboard.writeText(address); setCopied(address) } catch { setCopied('') }
  }

  if (targets.length === 0) return null
  return (
    <div className="text-xs mt-2 space-y-1.5" data-testid="work-email">
      <div className="text-gray-500 uppercase tracking-wide text-[10px]">Work email for the buyer</div>
      {targets.map(t => {
        const l = lookups[t.key]
        const v = l ? workEmailCopy(l) : null
        const retry = !l || l.status === 'error' || l.status === 'uncertain'
        // #1036: a found address whose mailbox was never checked (caps used up, or the check was off) can be checked later: no provider credit again
        const checkLater = !!providers?.mailboxCheck && !!l && l.status === 'unverified' && !!l.address && (l.mailbox_check ?? null) === null
        return (
          <div key={t.key} className="flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="work-email-row" data-status={l?.status ?? 'none'}>
            <span className="text-[#111] font-medium">{t.name}</span>{t.title ? <span className="text-gray-500">{t.title}</span> : null}
            {v && v.showAddress && l?.address && (
              <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 border ${v.checked ? 'border-green-600/40 text-green-800 bg-green-50' : 'border-amber-500/40 text-amber-800 bg-amber-50'}`} data-testid="work-email-address" data-checked={v.checked ? 'true' : 'false'}>
                <span className="font-mono break-all">{l.address}</span>
                <span className="text-[10px] uppercase tracking-wide">{v.checked ? (l.status === 'published' ? 'published' : l.status === 'unverified' ? 'checked' : 'verified') : 'not checked'}</span>
              </span>
            )}
            {v && v.showAddress && l?.address && v.checked && <button type="button" className="underline text-[#111]" onClick={() => void copy(l.address!)}>{copied === l.address ? 'Copied' : 'Copy'}</button>}
            {v && l?.status === 'published' && l.source_url && <a className="underline text-[#111]" href={l.source_url} target="_blank" rel="noopener noreferrer nofollow">page</a>}
            {retry && (
              <button type="button" disabled={!!busy[t.key]} onClick={() => void find(t.key)} data-testid="work-email-find"
                className="border border-[#111] px-2 py-0.5 text-[#111] bg-white hover:bg-[#111] hover:text-white disabled:opacity-50">
                {busy[t.key] ? 'Looking...' : l ? 'Try again' : 'Find work email'}
              </button>
            )}
            {checkLater && (
              <button type="button" disabled={!!busy[t.key]} onClick={() => void find(t.key)} data-testid="work-email-check"
                className="border border-[#111] px-2 py-0.5 text-[#111] bg-white hover:bg-[#111] hover:text-white disabled:opacity-50">
                {busy[t.key] ? 'Checking...' : 'Check mailbox'}
              </button>
            )}
            {v && <span className={v.tone === 'checked' ? 'text-green-800' : v.tone === 'unchecked' ? 'text-amber-800' : 'text-gray-600'} data-testid="work-email-status"><span className="font-medium">{v.headline}.</span> {v.note}</span>}
            {msg[t.key] ? <span className="text-gray-600" role="status">{msg[t.key]}</span> : null}
            {(() => {
              // A guess is offered only where nothing was found for the person: a found address is never joined by a guess.
              const g = guesses[nameKey(t.name)]
              if (!g || (l && l.address && v?.showAddress)) return null
              const c = guessCopy(g)
              return (
                <span className="basis-full flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="work-email-guess" data-label={g.label}>
                  <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 border ${c.checked ? 'border-green-600/40 text-green-800 bg-green-50' : 'border-amber-500/40 text-amber-800 bg-amber-50'}`}>
                    <span className="font-mono break-all">{g.address}</span>
                    <span className="text-[10px] uppercase tracking-wide">{c.chip}</span>
                  </span>
                  {c.checked && <button type="button" className="underline text-[#111]" onClick={() => void copy(g.address)}>{copied === g.address ? 'Copied' : 'Copy'}</button>}
                  <span className={c.checked ? 'text-green-800' : 'text-amber-800'}><span className="font-medium">{c.headline}.</span> {c.note}</span>
                  <span className="text-gray-600" data-testid="work-email-guess-source">{c.learned}{g.learned_from.filter(e => e.url && /^https?:\/\//i.test(e.url)).slice(0, 2).map(e => <a key={e.address} className="underline text-[#111] ml-1" href={e.url!} target="_blank" rel="noopener noreferrer nofollow">page</a>)}</span>
                </span>
              )
            })()}
          </div>
        )
      })}
      <div className="text-gray-500" data-testid="work-email-cost">{providers ? workEmailCostNote(providers) : 'Uses your own Apollo or People Data Labs key; free when the company website prints it.'} <a className="underline" href="/app/settings#enrichment">Settings &gt; Enrichment</a>. Drafts still use published addresses only.</div>
    </div>
  )
}
