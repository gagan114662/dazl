'use client'
import { useEffect, useState } from 'react'
import { trialRefusalNotice } from '@/lib/trial-copy'
import { googleLinkResultCopy } from '@/lib/google-link'

// #1095: a refused free-trial scan, in words, with the way forward (never the raw code). Google-required on a password
// account links Google to THIS account and comes back to this page with the same search ready to run.
export const PENDING_SEARCH_KEY = 'dazl_pending_search'
type Account = { verified: boolean; google: boolean }

// step: where on the page the search was started (the first-run steps), so the page can reopen there.
export function savePendingSearch(query: string, step?: string): void {
  try { sessionStorage.setItem(PENDING_SEARCH_KEY, JSON.stringify({ query, step: step ?? null, at: Date.now() })) } catch { /* private mode: the search is retyped */ }
}
// The search saved before leaving for Google, if it is recent (30 min); read once.
export function takePendingSearch(): { query: string; step: string | null } | null {
  try {
    const raw = sessionStorage.getItem(PENDING_SEARCH_KEY)
    sessionStorage.removeItem(PENDING_SEARCH_KEY)
    const v = raw ? JSON.parse(raw) as { query?: unknown; step?: unknown; at?: unknown } : null
    return v && typeof v.query === 'string' && typeof v.at === 'number' && Date.now() - v.at < 30 * 60_000 ? { query: v.query, step: typeof v.step === 'string' ? v.step : null } : null
  } catch { return null }
}
// The result of a Google link this page asked for (?google=...), removed from the address bar once read.
export function takeGoogleLinkResult(): { ok: boolean; text: string } | null {
  if (typeof window === 'undefined') return null
  const u = new URL(window.location.href)
  const r = u.searchParams.get('google')
  if (!r) return null
  u.searchParams.delete('google')
  window.history.replaceState(null, '', u.pathname + (u.search ? u.search : '') + u.hash)
  return googleLinkResultCopy(r)
}

export default function TrialRefusalNotice({ reason, query, step }: { reason: unknown; query: string; step?: string }) {
  const [account, setAccount] = useState<Account | null>(null)
  const [sent, setSent] = useState('')
  useEffect(() => { void fetch('/api/auth/email').then(r => r.ok ? r.json() : null).then(j => setAccount(j ? { verified: !!j.verified, google: !!j.google } : null)).catch(() => {}) }, [])
  const here = typeof window === 'undefined' ? '/app' : window.location.pathname + window.location.search
  const n = trialRefusalNotice(reason, here, account)
  async function resend() {
    const r = await fetch('/api/auth/email/send-verification', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => null)
    const j = r ? await r.json().catch(() => ({})) : {}
    setSent(r?.ok ? 'Sent. Open the link in your email, then come back here and link Google.' : (typeof j.error === 'string' ? j.error : 'Could not send it. Try again.'))
  }
  return (
    <div role="alert" className="rounded-lg border border-black/40 bg-[#f4f4f4] px-4 py-3 text-sm text-[#111]">
      <p>{n.text}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {n.actions.map(a => a.kind === 'resend_verification'
          ? <button key={a.kind} type="button" onClick={() => void resend()} className="btn-primary btn-sm">{a.label}</button>
          : <a key={a.kind} href={a.href} onClick={() => { if (a.kind === 'link_google') savePendingSearch(query, step) }} className={a.kind === 'link_google' ? 'btn-primary btn-sm' : 'btn-ghost btn-sm'}>{a.label}</a>)}
      </div>
      {sent && <p className="mt-2 text-[#555]">{sent}</p>}
    </div>
  )
}
