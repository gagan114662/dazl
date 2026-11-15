'use client'
import { useEffect, useState } from 'react'
import { fixtureFailureMessage, fixtureNextUrl } from '@/lib/scan/fixture-action-result'

// Test-tenant-only controls for the labelled verification fixture. Renders nothing for
// any other account. The fixture proves populated UI with synthetic rows; cleanup
// removes exactly what it created.
export default function VerificationFixture({ onChanged }: { onChanged?: () => void }) {
  const [state, setState] = useState<{ available: boolean; exists: boolean; firstTouchExists?: boolean; workEmailAvailable?: boolean; workEmailExists?: boolean; realCheckAvailable?: boolean } | null>(null)
  const [real, setReal] = useState({ company: '', url: '', who: '' })
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const load = () => fetch('/api/leads/verification-fixture').then(r => r.ok ? r.json() : null).then(setState).catch(() => {})
  useEffect(() => { void load() }, [])
  if (!state || !state.available) return null
  async function act(method: 'POST' | 'DELETE', action?: string, extra?: Record<string, string>) {
    setBusy(true); setNote('')
    try {
      const r = await fetch('/api/leads/verification-fixture', { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...(extra ?? {}) }) }).catch(() => null)
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
      {(state.workEmailAvailable || state.workEmailExists) && <>
        {' '}{state.workEmailExists
          ? <button className="underline" disabled={busy} onClick={() => void act('DELETE', 'work_email')}>remove the Find work email fixture</button>
          : <button className="underline" disabled={busy} onClick={() => void act('POST', 'work_email')}>create the Find work email fixture</button>}
        {' '}(staging only: one test-only lead naming five test buyers; Find work email answers from the staging fake People Data Labs and fake ZeroBounce)
      </>}
      {state.realCheckAvailable && <span className="block mt-1" data-testid="real-company-check">
        Staging: check a real company for Find work email{' '}
        <input className="border px-1 w-36" aria-label="Company name" placeholder="Company" value={real.company} onChange={e => setReal({ ...real, company: e.target.value })} />{' '}
        <input className="border px-1 w-48" aria-label="Company website" placeholder="https://..." value={real.url} onChange={e => setReal({ ...real, url: e.target.value })} />{' '}
        <input className="border px-1 w-36" aria-label="Buyer roles" placeholder="Owner; Broker" value={real.who} onChange={e => setReal({ ...real, who: e.target.value })} />{' '}
        <button className="underline" disabled={busy} onClick={() => void act('POST', 'work_email_real', real)}>check it</button>{' '}
        <button className="underline" disabled={busy} onClick={() => void act('DELETE', 'work_email_real')}>remove the checks</button>
        {' '}(real site crawl, no model call, no cost)
      </span>}
      {note && <span className="block mt-1 text-[#8a5a00]" role="status" data-testid="fixture-note">{note}</span>}
    </p>
  )
}
