"use client"
import { useEffect, useState } from 'react'

// First-login onboarding: what the seller sells (+ site) so dazl can aim the ICP.
// Renders nothing once the profile is saved.
export default function SellerCard() {
  const [show, setShow] = useState(false)
  const [sells, setSells] = useState('')
  const [website, setWebsite] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    void fetch('/api/settings/profile').then(r => r.ok ? r.json() : null).then(j => {
      if (!j) return
      if (j.sells) return
      setShow(true)
    }).catch(() => {})
  }, [])
  if (!show) return null
  async function save(e: React.FormEvent) {
    e.preventDefault()
    setError(''); setBusy(true)
    const r = await fetch('/api/settings/profile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sells, website }) })
    const j = await r.json().catch(() => ({}))
    setBusy(false)
    if (!r.ok) return setError(j.error || 'Could not save')
    setShow(false)
  }
  return (
    <form onSubmit={save} className="card p-4 mb-8 text-sm">
      <p className="font-medium mb-1">First: what does your company sell?</p>
      <p className="text-gray-400 text-xs mb-3">dazl uses this to work out who your buyers are. One line is enough.</p>
      <input className="field w-full mb-2" required maxLength={150} value={sells} onChange={e => setSells(e.target.value)} placeholder="e.g. Sales prospecting software for recruiting agencies" />
      <input className="field w-full mb-2" maxLength={200} value={website} onChange={e => setWebsite(e.target.value)} placeholder="Your website (optional, e.g. https://acme.com) - helps dazl learn what you sell" />
      {error && <p className="text-red-400 text-xs mb-2">{error}</p>}
      <div className="flex gap-3 items-center">
        <button disabled={busy || sells.trim().length < 3} className="btn-primary">{busy ? 'Saving...' : 'Save and continue'}</button>
        <button type="button" onClick={() => setShow(false)} className="text-gray-400 hover:text-white text-xs">Skip for now</button>
      </div>
    </form>
  )
}
