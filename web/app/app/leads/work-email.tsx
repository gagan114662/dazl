'use client'
import { useCallback, useMemo, useState } from 'react'
import { mergeLookups, workEmailCopy, type ShownLookup } from '@/lib/people/work-email-eligible'

// #1036 / #1250: "Find work email" for the buyer-role people on one lead gives the address the company prints for that person on its
// own website, with the page (lib/people/work-email.ts). Nothing else is an answer: no guess, no broker lookup, no mailbox check.
// Rows from the server are MERGED by updated_at (mergeLookups): a slow read never erases a newer result.
export interface WorkEmailTarget { key: string; name: string; title: string | null }
// initial (#1182): what the page read once with the lead list, so the block renders the answers at once with no request on mount.
export interface WorkEmailInitial { providers: unknown; lookups: unknown; guesses?: unknown }
export default function WorkEmail(p: { leadId: string; targets: WorkEmailTarget[]; initial?: WorkEmailInitial }) {
  return <WorkEmailFor key={p.leadId} {...p} />
}

function WorkEmailFor({ leadId, targets, initial }: { leadId: string; targets: WorkEmailTarget[]; initial?: WorkEmailInitial }) {
  const [ownLookups, setLookups] = useState<Record<string, ShownLookup>>({})
  const lookups = useMemo(() => initial ? mergeLookups(ownLookups, initial.lookups) : ownLookups, [ownLookups, initial])
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [msg, setMsg] = useState<Record<string, string>>({})
  const [copied, setCopied] = useState('')

  const find = useCallback(async (key: string) => {
    if (busy[key]) return
    setBusy(b => ({ ...b, [key]: true })); setMsg(m => ({ ...m, [key]: '' }))
    let text = 'Could not run the lookup. Try again.'
    try {
      const r = await fetch(`/api/leads/${leadId}/work-email`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: key }) })
      const j = await r.json().catch(() => ({})) as { lookup?: ShownLookup; error?: string }
      if (r.ok && j.lookup) { const l = j.lookup; setLookups(ls => mergeLookups(ls, [l], true)); text = '' }
      else if (j.error) text = String(j.error)
    } catch { /* keep the generic message */ }
    setMsg(m => ({ ...m, [key]: text })); setBusy(b => ({ ...b, [key]: false }))
  }, [busy, leadId])

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
        return (
          <div key={t.key} className="flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="work-email-row" data-status={l?.status ?? 'none'}>
            <span className="text-[#111] font-medium">{t.name}</span>{t.title ? <span className="text-gray-500">{t.title}</span> : null}
            {v?.showAddress && l?.address && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 border border-green-600/40 text-green-800 bg-green-50" data-testid="work-email-address">
                <span className="font-mono break-all">{l.address}</span>
                <span className="text-[10px] uppercase tracking-wide">published</span>
              </span>
            )}
            {v?.showAddress && l?.address && <button type="button" className="underline text-[#111]" onClick={() => void copy(l.address!)}>{copied === l.address ? 'Copied' : 'Copy'}</button>}
            {v?.showAddress && l?.source_url && <a className="underline text-[#111]" href={l.source_url} target="_blank" rel="noopener noreferrer nofollow">page</a>}
            {!l && (
              <button type="button" disabled={!!busy[t.key]} onClick={() => void find(t.key)} data-testid="work-email-find"
                className="border border-[#111] px-2 py-0.5 text-[#111] bg-white hover:bg-[#111] hover:text-white disabled:opacity-50">
                {busy[t.key] ? 'Looking...' : 'Find work email'}
              </button>
            )}
            {v && <span className={v.showAddress ? 'text-green-800' : 'text-gray-600'} data-testid="work-email-status"><span className="font-medium">{v.headline}.</span> {v.note}</span>}
            {msg[t.key] ? <span className="text-gray-600" role="status">{msg[t.key]}</span> : null}
          </div>
        )
      })}
    </div>
  )
}
