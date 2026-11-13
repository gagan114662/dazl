'use client'
import { useEffect, useState } from 'react'
import { fixtureFailureMessage, fixtureNextUrl } from '@/lib/scan/fixture-action-result'

// Test-tenant-only controls for the labelled verification fixture. Renders nothing for
// any other account. The fixture proves populated UI with synthetic rows; cleanup
// removes exactly what it created.
export default function VerificationFixture({ onChanged }: { onChanged?: () => void }) {
  const [state, setState] = useState<{ available: boolean; exists: boolean; firstTouchExists?: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const load = () => fetch('/api/leads/verification-fixture').then(r => r.ok ? r.json() : null).then(setState).catch(() => {})
  useEffect(() => { void load() }, [])
  if (!state || !state.available) return null
  async function act(method: 'POST' | 'DELETE', action?: string) {
    setBusy(true); setNote('')
    try {
      const r = await fetch('/api/leads/verification-fixture', { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({action}) }).catch(() => null)
      const body: unknown = r ? await r.json().catch(() => null) : null
      if (!r?.ok) { setNote(fixtureFailureMessage(r?.status ?? null, body)); return }
      const next = fixtureNextUrl(method, action, true, body)
      if (next) { window.location.assign(next); return }
      await load(); onChanged?.()
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
      {' '}{state.firstTouchExists
        ? <button className="underline" disabled={busy} onClick={() => void act('DELETE', 'first_touch')}>remove the first-touch autopilot fixture</button>
        : <button className="underline" disabled={busy} onClick={() => void act('POST', 'first_touch')}>create the first-touch autopilot fixture</button>}
      {' '}(one test-only lead to your own test inbox; confirm it under Needs your review, then autopilot drafts it)
      {note && <span className="block mt-1 text-[#8a5a00]" role="status" data-testid="fixture-note">{note}</span>}
    </p>
  )
}
