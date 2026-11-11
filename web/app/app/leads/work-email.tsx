'use client'
import { useEffect, useState } from 'react'
import { workEmailCopy, workEmailCostNote, type WorkEmailView } from '@/lib/people/work-email-eligible'

// #1036: "Find work email" for the buyer-role people on one lead (lib/people/work-email.ts runs the lookup on the server
// with the workspace's own Apollo / People Data Labs keys). Only a checked address (verified by the provider, or printed
// on the company website) is labelled checked; an unchecked one says so; nothing here drafts or sends.
type Lookup = WorkEmailView & { target: string }
type Providers = { apollo: boolean; pdl: boolean; pdlNeedsOptIn: boolean }
export interface WorkEmailTarget { key: string; name: string; title: string | null }

export default function WorkEmail({ leadId, targets }: { leadId: string; targets: WorkEmailTarget[] }) {
  const [lookups, setLookups] = useState<Record<string, Lookup>>({})
  const [providers, setProviders] = useState<Providers | null>(null)
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [msg, setMsg] = useState<Record<string, string>>({})
  const [copied, setCopied] = useState('')

  useEffect(() => {
    let live = true
    fetch(`/api/leads/${leadId}/work-email`).then(async r => {
      if (!r.ok || !live) return
      const j = await r.json() as { providers: Providers; lookups: Lookup[] }
      setProviders(j.providers)
      setLookups(Object.fromEntries((j.lookups ?? []).map(l => [l.target, l])))
    }).catch(() => { /* the button still works; the cost line just stays generic */ })
    return () => { live = false }
  }, [leadId])

  async function find(key: string) {
    if (busy[key]) return
    setBusy(b => ({ ...b, [key]: true })); setMsg(m => ({ ...m, [key]: '' }))
    let text = 'Could not run the lookup. Try again.'
    try {
      const r = await fetch(`/api/leads/${leadId}/work-email`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: key }) })
      const j = await r.json().catch(() => ({})) as { status?: string; lookup?: Lookup; detail?: string; error?: string }
      if (r.ok && j.lookup) { const l = j.lookup; setLookups(ls => ({ ...ls, [key]: l })); text = '' }
      else if (r.ok && j.status === 'no_key') text = 'No Apollo or People Data Labs key set. Add your own key in Settings > Enrichment.'
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
        return (
          <div key={t.key} className="flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="work-email-row" data-status={l?.status ?? 'none'}>
            <span className="text-[#111] font-medium">{t.name}</span>{t.title ? <span className="text-gray-500">{t.title}</span> : null}
            {v && v.showAddress && l?.address && (
              <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 border ${v.checked ? 'border-green-600/40 text-green-800 bg-green-50' : 'border-amber-500/40 text-amber-800 bg-amber-50'}`} data-testid="work-email-address" data-checked={v.checked ? 'true' : 'false'}>
                <span className="font-mono">{l.address}</span>
                <span className="text-[10px] uppercase tracking-wide">{v.checked ? (l.status === 'published' ? 'published' : 'verified') : 'not checked'}</span>
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
            {v && <span className={v.tone === 'checked' ? 'text-green-800' : v.tone === 'unchecked' ? 'text-amber-800' : 'text-gray-600'} data-testid="work-email-status"><span className="font-medium">{v.headline}.</span> {v.note}</span>}
            {msg[t.key] ? <span className="text-gray-600" role="status">{msg[t.key]}</span> : null}
          </div>
        )
      })}
      <div className="text-gray-500" data-testid="work-email-cost">{providers ? workEmailCostNote(providers) : 'Uses your own Apollo or People Data Labs key; free when the company website prints it.'} <a className="underline" href="/app/settings#enrichment">Settings &gt; Enrichment</a>. Drafts still use published addresses only.</div>
    </div>
  )
}
