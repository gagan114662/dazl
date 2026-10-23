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
  const [saved, setSaved] = useState('')
  const [bizName, setBizName] = useState('')
  const [savedBiz, setSavedBiz] = useState('')
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    void fetch('/api/settings/profile').then(r => r.ok ? r.json() : null).then(j => {
      if (!j) return
      setSavedBiz(String(j.business_name ?? '')); setBizName(String(j.business_name ?? ''))
      if (j.sells) { setSaved(String(j.sells)); setWebsite(String(j.website ?? '')); return }
      setShow(true)
    }).catch(() => {})
  }, [])
  if (saved && !editing) return (
    <p className="text-sm text-[#555] mb-6">What you sell: <span className="text-[#111]">{saved}</span>. Business name: <span className="text-[#111]">{savedBiz || 'not set (needed to create drafts)'}</span> <button type="button" onClick={() => { setSells(saved); setBizName(savedBiz); setEditing(true) }} className="underline underline-offset-4 ml-1">Edit</button></p>
  )
  if (!show && !editing) return null
  async function save(e: React.FormEvent) {
    e.preventDefault()
    setError(''); setBusy(true)
    const r = await fetch('/api/settings/profile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sells, website, business_name: bizName }) })
    const j = await r.json().catch(() => ({}))
    setBusy(false)
    if (!r.ok) return setError(j.error || 'Could not save')
    // Show what the server actually stored (it trims), not what was typed.
    setSaved(String(j.sells ?? sells.trim())); setSavedBiz(String(j.business_name ?? '')); setShow(false); setEditing(false)
  }
  return (
    <form onSubmit={save} className="card p-4 mb-8 text-sm">
      <p className="font-medium mb-1">First: what does your company sell?</p>
      <p className="text-gray-400 text-xs mb-3">dazl uses this to work out who your buyers are. One line is enough.</p>
      <input className="field w-full mb-2" maxLength={150} value={bizName} onChange={e => setBizName(e.target.value)} placeholder="Your business name (used in email drafts)" />
      <input className="field w-full mb-2" required maxLength={150} value={sells} onChange={e => setSells(e.target.value)} placeholder="e.g. Sales prospecting software for recruiting agencies" />
      <input className="field w-full mb-2" maxLength={200} value={website} onChange={e => setWebsite(e.target.value)} placeholder="Your website (optional, e.g. https://acme.com) - helps dazl learn what you sell" />
      {error && <p className="text-red-400 text-xs mb-2">{error}</p>}
      <div className="flex gap-3 items-center">
        <button disabled={busy || sells.trim().length < 3} className="btn-primary">{busy ? 'Saving...' : 'Save and continue'}</button>
        <button type="button" onClick={() => { setShow(false); setEditing(false) }} className="text-gray-400 hover:text-white text-xs">Skip for now</button>
      </div>
    </form>
  )
}
