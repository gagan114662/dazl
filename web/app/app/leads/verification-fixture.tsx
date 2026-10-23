'use client'
import { useEffect, useState } from 'react'

// Test-tenant-only controls for the labelled verification fixture. Renders nothing for
// any other account. The fixture proves populated UI with synthetic rows; cleanup
// removes exactly what it created.
export default function VerificationFixture({ onChanged }: { onChanged?: () => void }) {
  const [state, setState] = useState<{ available: boolean; exists: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const load = () => fetch('/api/leads/verification-fixture').then(r => r.ok ? r.json() : null).then(setState).catch(() => {})
  useEffect(() => { void load() }, [])
  if (!state || !state.available) return null
  async function act(method: 'POST' | 'DELETE', action?: string) {
    setBusy(true)
    try {
      const r = await fetch('/api/leads/verification-fixture', { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({action}) })
      if (r.ok) { await load(); onChanged?.() }
    } finally { setBusy(false) }
  }
  return (
    <p className="text-xs text-gray-500 mb-4">
      Test account:{' '}
      {state.exists
        ? <button className="underline" disabled={busy} onClick={() => void act('DELETE')}>remove the verification fixture</button>
        : <button className="underline" disabled={busy} onClick={() => void act('POST')}>create the verification fixture</button>}
      {' '}(labelled test-only rows; no scan, no email)
      {' '}<button className="underline" disabled={busy} onClick={()=>void act('POST','review_draft')}>create no-send review/draft display fixture</button>
      {' '}(synthetic contact, suppressed; no provider call; confirm manually for label proof)
    </p>
  )
}
