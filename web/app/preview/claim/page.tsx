'use client'
import { useEffect, useState } from 'react'
import { claimIntent, clearClaim } from '@/lib/invite-return'

// Completes a preview claim after password sign-in or sign-up (#416): the token this tab kept is POSTed once
// (the server binds it atomically); a GET of this page never consumes anything.
export default function ClaimPage() {
  const [state, setState] = useState<{ kind: 'working' | 'error'; code?: string }>({ kind: 'working' })
  useEffect(() => {
    const token = claimIntent()
    if (!token) { setState({ kind: 'error', code: 'none' }); return }
    fetch('/api/preview/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}))
        if (res.ok && data.id) { clearClaim(); window.location.href = `/app/preview/${data.id}`; return }
        setState({ kind: 'error', code: data.code || 'failed' })
      })
      .catch(() => setState({ kind: 'error', code: 'failed' }))
  }, [])
  const copy: Record<string, string> = {
    none: 'There is no preview claim in progress in this tab. Open your preview link again.',
    signed_out: 'Sign in to claim your preview.',
    unverified: 'Verify your email address, then open your preview link again to finish claiming it.',
    foreign: 'This preview was made for a different account. Sign in with the account it was sent to.',
    expired: 'This preview has expired.',
    unknown: 'This preview link is not valid.',
    too_many: 'Too many attempts. Try again in a few minutes.',
    failed: 'Something went wrong. Try again.',
  }
  return (
    <main style={{ maxWidth: 640, margin: '0 auto', padding: '48px 20px', fontFamily: 'system-ui, sans-serif' }}>
      {state.kind === 'working' ? <p>Claiming your preview...</p> : <p role="alert">{copy[state.code || 'failed'] || copy.failed}</p>}
    </main>
  )
}
