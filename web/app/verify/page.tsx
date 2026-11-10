'use client'
import { useEffect, useState } from 'react'

// Opened from the verification email. The token is in the #fragment, so it never reaches a server log.
export default function Verify() {
  const [state, setState] = useState<'working' | 'done' | 'invalid' | 'none'>('working')
  useEffect(() => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get('t') ?? ''
    history.replaceState(null, '', window.location.pathname)
    if (!token) { queueMicrotask(() => setState('none')); return }
    void fetch('/api/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) })
      .then(r => setState(r.ok ? 'done' : 'invalid')).catch(() => setState('invalid'))
  }, [])
  return (
    <main id="main" className="min-h-screen flex items-center justify-center glow px-4 py-10">
      <div className="card p-8 sm:p-10 w-full max-w-sm text-center">
        <h1 className="text-2xl font-medium mb-3">Confirm your email</h1>
        {state === 'working' && <p className="text-[#555] text-sm">Confirming...</p>}
        {state === 'done' && <p className="text-[#555] text-sm">Your email is confirmed. <a className="underline underline-offset-2" href="/sign-in">Sign in to dazl</a></p>}
        {state === 'invalid' && <p className="text-[#555] text-sm">This link has expired or was already used. <a className="underline underline-offset-2" href="/sign-in">Sign in</a>: if your email is not confirmed yet, we email you a new link.</p>}
        {state === 'none' && <p className="text-[#555] text-sm">Open the link from the email we sent you.</p>}
      </div>
    </main>
  )
}
