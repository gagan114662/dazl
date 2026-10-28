'use client'
import { useEffect, useState } from 'react'
import { AI_COST_LINE, LIMITS_LINE, usageLine } from '@/lib/billing/allowance'

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
  // The return from Stripe Checkout (lib/billing/stripe.ts success_url / cancel_url). The URL is not evidence of a
  // payment (anyone can type it): what the panel says comes only from the plan the server holds, which only a signed
  // Stripe webhook changes.
  const [back, setBack] = useState<'success' | 'cancelled' | null>(null)
  const [checking, setChecking] = useState(false)
  useEffect(() => {
    const b = new URLSearchParams(window.location.search).get('billing')
    const ret = b === 'success' || b === 'cancelled' ? b : null
    let tries = 0, stop = false
    // after a successful checkout the plan changes when Stripe's webhook arrives: re-read for a short while
    const load = () => void fetch('/api/usage').then(r => (r.ok ? r.json() : null)).then((j: Usage | null) => {
      if (stop || !j) return
      setBack(ret); setU(j)
      const again = ret === 'success' && j.plan !== 'pro' && ++tries < 10
      setChecking(again)
      if (again) setTimeout(load, 2000)
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
      {back === 'success' && <p className="text-sm mb-2" data-testid="billing-return">{u.plan === 'pro'
        ? 'Your Pro plan is active.'
        : checking
          ? 'Checking your subscription with Stripe. This updates as soon as Stripe confirms it.'
          : 'No confirmed subscription yet. If you just finished checkout it can take a minute to show here; refresh this page. Your plan stays as shown until Stripe confirms it.'}</p>}
      {back === 'cancelled' && <p className="text-sm text-[#555] mb-2" data-testid="billing-return">{`Checkout was not completed. Your plan is still ${u.plan === 'pro' ? 'Pro' : 'Free'}.`}</p>}
      {note && <p className="text-sm mb-2" data-testid="billing-status">{note}</p>}
      <p className="text-[#555] text-sm mb-1" data-testid="plan-usage">{usageLine(u.plan === 'pro' ? 'pro' : 'free', u.scans_used, u.scan_limit)}</p>
      <p className={`text-[#555] text-sm ${u.trial ? 'mb-1' : 'mb-4'}`} data-testid="plan-limits">{LIMITS_LINE} {AI_COST_LINE}</p>
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
