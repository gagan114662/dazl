'use client'
import { useEffect, useState } from 'react'

const COPY: Record<string, string> = {
  no_token: 'Open the invitation link you were sent; it carries the code this page needs.',
  invalid_invite: 'This invitation link has expired, was already used, or was withdrawn. Ask for a new one.',
  wrong_account: 'This invitation was sent to a different email address. Sign in with that account, then open the link again.',
}

// The invitation token travels in the #fragment, so it never reaches a server log; it is posted once from here.
export default function Join() {
  const [state, setState] = useState<'working' | 'done' | string>('working')
  useEffect(() => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get('t') ?? ''
    history.replaceState(null, '', window.location.pathname)
    if (!token) { queueMicrotask(() => setState('no_token')); return }
    void fetch('/api/workspace/invitations/accept', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) })
      .then(async r => { const j = await r.json().catch(() => ({})); setState(r.ok ? 'done' : j.error || 'error') })
      .catch(() => setState('error'))
  }, [])
  return (
    <div className="p-8 max-w-xl">
      <h1 className="text-2xl font-semibold tracking-tight mb-3">Join a workspace</h1>
      {state === 'working' && <p className="text-[#555]">Accepting the invitation...</p>}
      {state === 'done' && <p className="text-[#555]">You are in. <a className="underline underline-offset-4" href="/app">Open the workspace</a>.</p>}
      {state !== 'working' && state !== 'done' && <p className="text-[#555]">{COPY[state] ?? 'Something went wrong. Try the link again.'}</p>}
    </div>
  )
}
