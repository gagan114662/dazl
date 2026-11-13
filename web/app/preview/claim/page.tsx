'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { claimIntent, clearClaim } from '@/lib/invite-return'

// Completes a preview claim after sign-in or sign-up (#416). Claiming is an intentional act: this page confirms
// first and POSTs only when the person clicks - never automatically on landing. A GET never consumes anything.
// The token rides in this tab's sessionStorage (password path) or the dazl_claim cookie (Google path). Either way the
// page first reads (read-only) what the claim names, so the first screen after auth shows the prospect's own offer and
// proof, and a dead link is said to be dead before anyone clicks.
type Proof = {
  business: string; expiresAt: number; offer: { text: string; sourceUrl: string }; disclaimer: string
  companies: { company: string; event: string; eventDate: string; quote: string; sourceUrl: string }[]
}
type Intent = { token?: string; proof: Proof }
const wrap = { maxWidth: 640, margin: '0 auto', padding: '48px 20px', fontFamily: 'system-ui, sans-serif', color: '#1a1a1a' } as const
export default function ClaimPage() {
  const router = useRouter()
  const [intent, setIntent] = useState<Intent | 'loading' | { dead: string }>('loading')
  const [state, setState] = useState<{ kind: 'confirm' | 'working' | 'error'; code?: string }>({ kind: 'confirm' })
  useEffect(() => {
    const kept = claimIntent()
    // Password path: the tab's own token; Google path: the httpOnly intent cookie (the server reads it).
    const url = kept ? `/api/preview/claim?t=${encodeURIComponent(kept.token)}` : '/api/preview/claim'
    fetch(url, { headers: { accept: 'application/json' } })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}))
        if (res.ok && data.ok) { setIntent({ ...(kept ? { token: kept.token } : {}), proof: data as Proof }); return }
        if (!kept && res.status === 404) { setIntent({ dead: 'none' }); return }
        setIntent({ dead: typeof data.code === 'string' ? data.code : 'failed' })
      })
      .catch(() => setIntent({ dead: 'failed' }))
  }, [])
  const submit = () => {
    if (intent === 'loading' || 'dead' in intent) return
    setState({ kind: 'working' })
    const body = intent.token ? { token: intent.token } : {}
    fetch('/api/preview/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}))
        if (res.ok && data.id) { clearClaim(); window.location.href = `/app/preview/${data.id}`; return }
        setState({ kind: 'error', code: data.code || 'failed' })
      })
      .catch(() => setState({ kind: 'error', code: 'failed' }))
  }
  // Drops the intent (this tab's token and the cookie) and goes to the workspace; nothing is claimed.
  const notNow = () => {
    clearClaim()
    fetch('/api/preview/claim', { method: 'DELETE', headers: { 'content-type': 'application/json' } })
      .catch(() => { /* the cookie also expires on its own */ })
      .finally(() => { router.push('/app') })
  }
  const copy: Record<string, string> = {
    none: 'There is no preview claim in progress. Open your preview link again.',
    signed_out: 'Sign in to claim your preview.',
    unverified: 'Verify your email address (we sent you a link), then open your preview link again to finish claiming it.',
    foreign: 'This preview was made for a different account. Sign in with the account it was sent to.',
    claimed_other_workspace: 'This preview was already claimed in another of your workspaces. Switch workspace to see it.',
    expired: 'This preview has expired.',
    claimed: 'This preview has already been claimed.',
    unknown: 'This preview link is not valid.',
    too_many: 'Too many attempts. Try again in a few minutes.',
    failed: 'Something went wrong. Try again.',
  }
  if (intent === 'loading') return <main style={wrap}><p>Loading...</p></main>
  if ('dead' in intent) return <main style={wrap}><p role="alert">{copy[intent.dead] || copy.failed}</p><p><button onClick={notNow} style={{ padding: '8px 14px', cursor: 'pointer' }}>Go to my workspace</button></p></main>
  const p = intent.proof
  return (
    <main style={wrap} data-testid="claim-proof">
      <p style={{ color: '#666', fontSize: 13, textTransform: 'uppercase', letterSpacing: 1 }}>Proof preview prepared for {p.business}</p>
      <h1 style={{ fontSize: 24 }}>Claim your preview{p.business ? ` for ${p.business}` : ''}?</h1>
      <p><em>Inferred offer:</em> {p.offer.text} (<a href={p.offer.sourceUrl}>source</a>)</p>
      <ul style={{ paddingLeft: 18 }}>
        {p.companies.map((co) => (
          <li key={co.company} style={{ marginBottom: 16 }}>
            <strong>{co.company}</strong> - {co.event} ({co.eventDate})<br />
            <span style={{ color: '#444' }}>&quot;{co.quote}&quot;</span> <a href={co.sourceUrl}>source</a>
          </li>
        ))}
      </ul>
      <p style={{ color: '#666', fontSize: 13 }}>{p.disclaimer}</p>
      <p>This attaches the proof preview to this account. Only the account it was sent to can claim it.</p>
      {state.kind === 'error' && <p role="alert">{copy[state.code || 'failed'] || copy.failed}</p>}
      <button onClick={submit} disabled={state.kind === 'working'} style={{ padding: '10px 16px', background: '#111', color: '#fff', borderRadius: 8, border: 'none', cursor: 'pointer' }}>
        {state.kind === 'working' ? 'Claiming...' : 'Claim this preview'}
      </button>{' '}
      <button onClick={notNow} disabled={state.kind === 'working'} style={{ padding: '10px 16px', background: 'none', color: '#111', borderRadius: 8, border: '1px solid #999', cursor: 'pointer' }}>
        Not now, go to my workspace
      </button>
    </main>
  )
}
