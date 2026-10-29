'use client'
import { useEffect, useState } from 'react'

// Without a token: ask for the email to send a reset link to. With one (from the email's #fragment, never sent to a
// server log): choose the new password.
export default function Reset() {
  const [token, setToken] = useState<string | null>(null)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const t = new URLSearchParams(window.location.hash.slice(1)).get('t')
    if (t) { history.replaceState(null, '', window.location.pathname); queueMicrotask(() => setToken(t)) }
  }, [])

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setBusy(true); setMsg('')
    const fd = new FormData(e.currentTarget)
    const r = token
      ? await fetch('/api/auth/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, password: fd.get('password') }) })
      : await fetch('/api/auth/reset/request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: fd.get('email') }) })
    const j = await r.json().catch(() => ({}))
    setBusy(false)
    if (token && r.ok) { window.location.href = j.redirect || '/sign-in?reset=1'; return }
    if (token) setMsg(j.error === 'invalid_link' ? 'This link has expired or was already used. Ask for a new one.' : j.error || 'Something went wrong')
    else setMsg(r.ok ? j.message : j.error || 'Something went wrong')
  }

  return (
    <main className="min-h-screen flex items-center justify-center glow px-4 py-10">
      <div className="card p-8 sm:p-10 w-full max-w-sm">
        <h1 className="text-2xl font-medium mb-1 text-center">{token ? 'Choose a new password' : 'Reset your password'}</h1>
        <p className="text-[#555] text-sm mb-6 text-center">{token ? 'This signs your account out on every device.' : 'We will email you a link that works for 30 minutes.'}</p>
        {msg && <p role="status" className="text-[#111] text-sm mb-4 text-center bg-[#f4f4f4] border border-black/40 rounded-lg px-3 py-2">{msg}</p>}
        <form onSubmit={submit} className="flex flex-col gap-3">
          {token
            ? <input name="password" type="password" required minLength={10} autoComplete="new-password" placeholder="New password (10+ characters, letters and numbers)" className="field" />
            : <input name="email" type="email" required autoComplete="email" placeholder="you@company.com" className="field" />}
          <button type="submit" disabled={busy} className="btn-primary mt-1 !py-3">{busy ? 'Working...' : token ? 'Set password' : 'Send link'}</button>
        </form>
        <p className="mt-4 text-sm text-[#666] text-center"><a href="/sign-in" className="text-[#111] underline underline-offset-2">Back to sign in</a></p>
      </div>
    </main>
  )
}
