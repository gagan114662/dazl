'use client'
import { useEffect, useState } from 'react'
import { takeGoogleLinkResult } from '../trial-refusal-notice'

type Status = { email: string; verified: boolean; google: boolean }
const fetchStatus = (): Promise<Status | null> => fetch('/api/auth/email').then(r => r.ok ? r.json() : null).catch(() => null)
const browserZone = (): string => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || '' } catch { return '' } }
const postProfile = (body: unknown): Promise<{ timezone?: string | null } | null> =>
  fetch('/api/settings/profile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.ok ? r.json() : null).catch(() => null)

// The account's email, whether it is confirmed, changing it, and adding Google sign-in. Joining a team workspace
// needs a confirmed email.
export default function AccountPanel() {
  const [s, setS] = useState<Status | null>(null)
  const [msg, setMsg] = useState('')
  const [next, setNext] = useState('')
  // #2054 follow-up: the account's time zone (its day for send caps and reset times). Loaded on its own fetch, so a
  // profile failure hides only this control, never the panel. undefined = not loaded or failed.
  const [zone, setZone] = useState<string | null | undefined>(undefined)
  const [tzInput, setTzInput] = useState('')
  useEffect(() => {
    void fetchStatus().then(setS)
    // #1319: the link result arrives in a short-lived cookie (or an old ?google= address), read once
    const g = takeGoogleLinkResult()
    if (g) queueMicrotask(() => setMsg(g.text))
  }, [])
  useEffect(() => {
    let live = true
    void fetch('/api/settings/profile').then(r => r.ok ? r.json() : null).catch(() => null).then((p: { timezone?: string | null } | null) => {
      if (!live || !p) return
      setZone(p.timezone ?? null)
      // No saved zone - a Google or native-form sign-up, or an older account: prefill this browser's zone as an
      // unsaved field value, so the account's day is one Save away. Nothing is written on load; the panel's Save
      // persists it through the profile route like any other edit.
      setTzInput(p.timezone ?? browserZone())
    })
    return () => { live = false }
  }, [])
  async function saveZone() {
    const j = await postProfile({ timezone: tzInput.trim() })
    if (j) { setZone(j.timezone ?? null); setTzInput(j.timezone ?? ''); setMsg('Time zone saved.') }
    else setMsg('That time zone was not saved. Check the spelling, like America/Toronto.')
  }
  async function post(path: string, body: unknown, done: (j: { sent?: boolean; message?: string }) => string) {
    const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const j = await r.json().catch(() => ({}))
    setMsg(r.ok ? done(j) : j.error === 'reauth_required' ? 'Confirm it is you first (top of this page).' : j.error || 'Something went wrong')
  }
  if (!s) return null
  return (
    <div className="card p-6 mb-4">
      <h2 className="font-semibold mb-1">Account</h2>
      <p className="text-sm text-[#555]">{s.email} · {s.verified ? 'confirmed' : 'not confirmed yet'}{s.google ? ' · signs in with Google' : ''}</p>
      <div className="flex flex-wrap gap-3 mt-3 text-sm">
        {!s.verified && <button className="btn-primary" onClick={() => void post('/api/auth/email/send-verification', {}, j => j.sent ? `We sent a link to ${s.email}. It works for 24 hours.` : 'Already confirmed.')}>Send confirmation link</button>}
        {/* #1095: an unconfirmed account can link too (the link confirms the address) */}
        {!s.google && <a className="underline underline-offset-2 inline-flex items-center min-h-[44px]" href="/api/auth/google?link=1">Add Google sign-in</a>}
      </div>
      <div className="flex flex-wrap gap-2 mt-3 text-sm">
        <input className="field max-sm:basis-full sm:flex-1 sm:min-w-[12rem]" type="email" placeholder="New email address" value={next} onChange={e => setNext(e.target.value)} />
        <button className="btn-primary max-sm:w-full" disabled={!next.trim()} onClick={() => void post('/api/auth/email', { email: next }, j => { setNext(''); return j.message ?? 'Check the new address for a link.' })}>Change email</button>
      </div>
      {zone !== undefined && (
        <div className="mt-3 text-sm">
          <div className="flex flex-wrap gap-2 items-center">
            <label className="text-[#555]" htmlFor="account-timezone">Time zone</label>
            <input id="account-timezone" className="field max-sm:basis-full sm:flex-1 sm:min-w-[12rem]" type="text" placeholder="America/Toronto" value={tzInput} onChange={e => setTzInput(e.target.value)} />
            <button className="btn-primary max-sm:w-full" disabled={!tzInput.trim()} onClick={() => void saveZone()}>Save time zone</button>
          </div>
          <p className="text-xs text-[#555] mt-1">Your day for send caps, trial counts and reset times.</p>
        </div>
      )}
      {msg && <p className="text-sm text-[#555] mt-2">{msg}</p>}
    </div>
  )
}
