'use client'
import { useEffect, useState } from 'react'

export default function PlanPanel() {
  const [u, setU] = useState<{ plan: string; scans_used: number; scan_limit: number | null } | null>(null)
  const [msg, setMsg] = useState('')
  useEffect(() => { void fetch('/api/usage').then(r => (r.ok ? r.json() : null)).then(setU) }, [])

  async function go(path: string) {
    setMsg('')
    const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    const j = await r.json()
    if (r.ok && j.url) window.location.href = j.url
    else setMsg(j.error || 'Something went wrong')
  }

  if (!u) return null
  return (
    <div className="card p-6 mb-4">
      <h2 className="font-semibold mb-1">Plan <span className="badge ml-2">{u.plan === 'pro' ? 'Pro' : 'Free'}</span></h2>
      <p className="text-gray-400 text-sm mb-4">{u.scan_limit === null ? `${u.scans_used} scans this month, unlimited.` : `${u.scans_used} of ${u.scan_limit} scans used this month.`}</p>
      {u.plan === 'pro'
        ? <button onClick={() => go('/api/billing/portal')} className="btn-ghost">Manage billing</button>
        : <button onClick={() => go('/api/billing/checkout')} className="btn-primary">Upgrade to Pro</button>}
      {msg && <p className="text-sm text-gray-400 mt-3">{msg}</p>}
    </div>
  )
}
