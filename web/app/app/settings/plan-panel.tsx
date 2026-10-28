'use client'
import { useEffect, useState } from 'react'

type Usage = { plan: string; scans_used: number; scan_limit: number | null; billing_status: string | null; trial: { funded: boolean; remaining: number; cap: number } | null }

// What the subscription's Stripe status means for the user (lib/billing/stripe.ts statusEffect decides the plan; this
// only explains it). Statuses not listed need no note.
const STATUS_NOTE: Record<string, string> = {
  past_due: 'Your last payment failed. Stripe is retrying it - update your card in Manage billing to keep Pro.',
  unpaid: 'Your subscription is unpaid, so the plan is back to Free. Upgrade again to restore Pro.',
  incomplete: 'Your payment did not complete, so the plan is still Free.',
  incomplete_expired: 'Your payment did not complete in time, so the plan is still Free.',
  paused: 'Your subscription is paused, so the plan is Free until it resumes.',
  canceled: 'Your Pro subscription has ended. You are on the Free plan.',
}

export default function PlanPanel() {
  const [u, setU] = useState<Usage | null>(null)
  const [msg, setMsg] = useState('')
  // the return from Stripe Checkout (lib/billing/stripe.ts success_url / cancel_url)
  const [back, setBack] = useState<'success' | 'cancelled' | null>(null)
  useEffect(() => {
    const b = new URLSearchParams(window.location.search).get('billing')
    const ret = b === 'success' || b === 'cancelled' ? b : null
    let tries = 0, stop = false
    // after a successful checkout the plan changes when Stripe's webhook arrives: re-read for a short while
    const load = () => void fetch('/api/usage').then(r => (r.ok ? r.json() : null)).then((j: Usage | null) => {
      if (stop || !j) return
      setBack(ret); setU(j)
      if (ret === 'success' && j.plan !== 'pro' && ++tries < 10) setTimeout(load, 2000)
    }).catch(() => {})
    load()
    return () => { stop = true }
  }, [])

  async function go(path: string) {
    setMsg('')
    const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    const j = await r.json()
    if (r.ok && j.url) window.location.href = j.url
    else setMsg(j.error || 'Something went wrong')
  }

  if (!u) return null
  const note = u.billing_status ? STATUS_NOTE[u.billing_status] : undefined
  return (
    <div className="card p-6 mb-4" data-testid="plan-panel">
      <h2 className="font-semibold mb-1">Plan <span className="badge ml-2" data-testid="plan-badge">{u.plan === 'pro' ? 'Pro' : 'Free'}</span></h2>
      {back === 'success' && <p className="text-sm mb-2" data-testid="billing-return">{u.plan === 'pro' ? 'Payment received. You are on Pro.' : 'Payment received. Your plan updates as soon as Stripe confirms it, usually within a few seconds.'}</p>}
      {back === 'cancelled' && <p className="text-sm text-[#555] mb-2" data-testid="billing-return">Checkout was cancelled. Nothing was charged.</p>}
      {note && <p className="text-sm mb-2" data-testid="billing-status">{note}</p>}
      <p className={`text-[#555] text-sm ${u.trial ? 'mb-1' : 'mb-4'}`}>{u.scan_limit === null ? `${u.scans_used} scans this month, unlimited.` : `${u.scans_used} of ${u.scan_limit} scans used this month.`}</p>
      {u.trial && (
        <p className="text-[#555] text-sm mb-4">
          {u.trial.remaining > 0
            ? `${u.trial.remaining} of ${u.trial.cap} free trial scans left - add your Anthropic key below for the full ${u.scan_limit ?? 'plan'} scans a month.`
            : `Your ${u.trial.cap} free trial scans are used up - add your Anthropic key below to keep scanning.`}
        </p>
      )}
      {u.plan === 'pro'
        ? <button onClick={() => go('/api/billing/portal')} className="btn-ghost">Manage billing</button>
        : <button onClick={() => go('/api/billing/checkout')} className="btn-primary">Upgrade to Pro</button>}
      {msg && <p className="text-sm text-[#555] mt-3">{msg}</p>}
    </div>
  )
}
