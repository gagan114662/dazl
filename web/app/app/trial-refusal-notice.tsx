'use client'
import { useEffect, useState } from 'react'
import { trialRefusalNotice } from '@/lib/trial-copy'
import { googleLinkResultCopy } from '@/lib/google-link'

// #1095: a refused free-trial scan, in words, with the way forward (never the raw code). Google-required on a password
// account links Google to THIS account and comes back to this page with the same search ready to run.
export const PENDING_SEARCH_KEY = 'dazl_pending_search'
type Account = { verified: boolean; google: boolean; fresh: boolean }

// step: where on the page the search was started (the first-run steps), so the page can reopen there.
export function savePendingSearch(query: string, step?: string): void {
  try { sessionStorage.setItem(PENDING_SEARCH_KEY, JSON.stringify({ query, step: step ?? null, at: Date.now() })) } catch { /* private mode: the search is retyped */ }
}
// The search saved before leaving for Google, if it is recent (30 min); read once. Read it only after a link that
// worked: after a failed one it stays for the next attempt.
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
  window.history.replaceState(null, '', u.pathname + u.search + u.hash)
  return googleLinkResultCopy(r)
}

async function loadAccount(): Promise<Account | null> {
  const [email, reauth] = await Promise.all([
    fetch('/api/auth/email').then(r => r.ok ? r.json() : null).catch(() => null),
    fetch('/api/auth/reauth').then(r => r.ok ? r.json() : null).catch(() => null),
  ])
  return email ? { verified: !!email.verified, google: !!email.google, fresh: reauth ? !!reauth.fresh : true } : null
}

export default function TrialRefusalNotice({ reason, query, step, text }: { reason: unknown; query: string; step?: string; text?: string }) {
  const [account, setAccount] = useState<Account | null>(null)
  const [here, setHere] = useState('/app')
  const [note, setNote] = useState('')
  const [password, setPassword] = useState('')
  useEffect(() => {
    void loadAccount().then(setAccount)
    queueMicrotask(() => setHere(window.location.pathname + window.location.search))
    // confirming the email in another tab: read the account again when the user comes back to this one
    const back = () => { if (document.visibilityState === 'visible') void loadAccount().then(setAccount) }
    document.addEventListener('visibilitychange', back)
    return () => document.removeEventListener('visibilitychange', back)
  }, [])
  const n = trialRefusalNotice(reason, here, account)
  async function resend() {
    const r = await fetch('/api/auth/email/send-verification', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => null)
    const j = r ? await r.json().catch(() => ({})) : {}
    if (r?.ok && j.sent === false) { setNote('Your email is already confirmed.'); void loadAccount().then(setAccount); return }
    setNote(r?.ok ? 'Sent. Open the link in your email, then come back here and link Google.' : (typeof j.error === 'string' ? j.error : 'Could not send it. Try again.'))
  }
  async function reauth(e: React.FormEvent) {
    e.preventDefault()
    const r = await fetch('/api/auth/reauth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) }).catch(() => null)
    const j = r ? await r.json().catch(() => ({})) : {}
    setPassword('')
    if (r?.ok) { setNote(''); void loadAccount().then(setAccount); return }
    setNote(typeof j.error === 'string' ? j.error : 'That password did not work. Try again.')
  }
  return (
    <div className="rounded-lg border border-black/40 bg-[#f4f4f4] px-4 py-3 text-sm text-[#111]" data-testid="trial-refusal-notice">
      <p role="alert">{text ?? n.text}</p>
      {n.actions.length > 0 && <div className="mt-3 flex flex-wrap items-center gap-2">
        {n.actions.map(a => a.kind === 'resend_verification'
          ? <button key={a.kind} type="button" onClick={() => void resend()} className="btn-primary btn-sm">{a.label}</button>
          : a.kind === 'reauth'
            ? <form key={a.kind} onSubmit={e => void reauth(e)} className="flex flex-wrap items-center gap-2">
              <label className="sr-only" htmlFor="trial-reauth-password">Your password</label>
              <input id="trial-reauth-password" type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} placeholder="Your password" className="field !py-1.5 text-sm" />
              <button type="submit" className="btn-primary btn-sm">{a.label}</button>
            </form>
            : <a key={a.kind} href={a.href} onClick={() => { if (a.kind === 'link_google') savePendingSearch(query, step) }} className={a.kind === 'link_google' ? 'btn-primary btn-sm' : 'btn-ghost btn-sm'}>{a.label}</a>)}
      </div>}
      {note && <p className="mt-2 text-[#555]" role="status">{note}</p>}
    </div>
  )
}
