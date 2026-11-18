'use client'
import { useEffect, useState } from 'react'
import { verifyResult, verifyResultCopy, type VerifyResult } from './result'

// Opened from the verification email. The token is in the #fragment, so it never reaches a server log.
export default function Verify() {
  const [state, setState] = useState<VerifyResult | 'working' | 'none'>('working')
  useEffect(() => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get('t') ?? ''
    history.replaceState(null, '', window.location.pathname)
    if (!token) { queueMicrotask(() => setState('none')); return }
    void fetch('/api/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) })
      .then(r => setState(verifyResult(r.status))).catch(() => setState(verifyResult()))
  }, [])
  return (
    <main id="main" className="min-h-screen flex items-center justify-center glow px-4 py-10">
      <div className="card p-8 sm:p-10 w-full max-w-sm text-center">
        <h1 className="text-2xl font-medium mb-3">Confirm your email</h1>
        {state === 'working' && <p className="text-[#555] text-sm">Confirming...</p>}
        {state === 'done' && <p className="text-[#555] text-sm">Your email is confirmed. <a className="underline underline-offset-2" href="/sign-in">Sign in to dazl</a></p>}
        {(state === 'unusable' || state === 'uncertain' || state === 'limited') &&
          <p className="text-[#555] text-sm" role="status">{verifyResultCopy[state]} <a className="underline underline-offset-2" href="/sign-in">Sign in</a> to check whether your email is already confirmed. If it’s still pending, follow the sign-in instructions.</p>}
        {state === 'none' && <p className="text-[#555] text-sm">Open the link from the email we sent you.</p>}
      </div>
    </main>
  )
}
