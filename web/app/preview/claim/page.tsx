'use client'
import { useEffect, useState } from 'react'
import { claimIntent, clearClaim } from '@/lib/invite-return'

// Completes a preview claim after sign-in or sign-up (#416). Claiming is an intentional act: this page confirms
// first and POSTs only when the person clicks - never automatically on landing. A GET never consumes anything.
// The token rides in this tab's sessionStorage (password path) or the dazl_claim cookie (Google path).
type Intent = { token: string; business: string } | { cookie: true; business: string }
export default function ClaimPage() {
  const [intent, setIntent] = useState<Intent | null | 'loading'>('loading')
  const [state, setState] = useState<{ kind: 'confirm' | 'working' | 'error'; code?: string }>({ kind: 'confirm' })
  useEffect(() => {
    const kept = claimIntent()
    if (kept) { setIntent(kept); return }
    // Google path: the intent is the httpOnly cookie; ask the server what it names (read-only).
    fetch('/api/preview/claim', { headers: { accept: 'application/json' } })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}))
        setIntent(res.ok && data.ok ? { cookie: true, business: data.business || '' } : null)
      })
      .catch(() => setIntent(null))
  }, [])
  const submit = () => {
    if (!intent || intent === 'loading') return
    setState({ kind: 'working' })
    const body = 'token' in intent ? { token: intent.token } : {}
    fetch('/api/preview/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}))
        if (res.ok && data.id) { clearClaim(); window.location.href = `/app/preview/${data.id}`; return }
        setState({ kind: 'error', code: data.code || 'failed' })
      })
      .catch(() => setState({ kind: 'error', code: 'failed' }))
  }
  const copy: Record<string, string> = {
    none: 'There is no preview claim in progress. Open your preview link again.',
    signed_out: 'Sign in to claim your preview.',
    unverified: 'Verify your email address, then open your preview link again to finish claiming it.',
    foreign: 'This preview was made for a different account. Sign in with the account it was sent to.',
    claimed_other_workspace: 'This preview was already claimed in another of your workspaces. Switch workspace to see it.',
    expired: 'This preview has expired.',
    claimed: 'This preview has already been claimed.',
    unknown: 'This preview link is not valid.',
    too_many: 'Too many attempts. Try again in a few minutes.',
    failed: 'Something went wrong. Try again.',
  }
  if (intent === 'loading') return <main style={{ maxWidth: 640, margin: '0 auto', padding: '48px 20px', fontFamily: 'system-ui, sans-serif' }}><p>Loading...</p></main>
  if (!intent) return <main style={{ maxWidth: 640, margin: '0 auto', padding: '48px 20px', fontFamily: 'system-ui, sans-serif' }}><p role="alert">{copy.none}</p></main>
  if (state.kind === 'error') return <main style={{ maxWidth: 640, margin: '0 auto', padding: '48px 20px', fontFamily: 'system-ui, sans-serif' }}><p role="alert">{copy[state.code || 'failed'] || copy.failed}</p></main>
  return (
    <main style={{ maxWidth: 640, margin: '0 auto', padding: '48px 20px', fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ fontSize: 24 }}>Claim your preview{intent.business ? ` for ${intent.business}` : ''}?</h1>
      <p>This attaches the proof preview to this account. Only the account it was sent to can claim it.</p>
      <button onClick={submit} disabled={state.kind === 'working'} style={{ padding: '10px 16px', background: '#111', color: '#fff', borderRadius: 8, border: 'none', cursor: 'pointer' }}>
        {state.kind === 'working' ? 'Claiming...' : 'Claim this preview'}
      </button>
    </main>
  )
}
