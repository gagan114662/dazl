'use client'
import { useEffect, useState } from 'react'

// #1721: the key rows, spending limits and lookup history for outside data services are gone from Settings (the account's own
// keys were removed, #1703). What stays is the one thing a customer can still see here: how many email address checks this
// workspace has used today and this month.
type MailboxChecks = { state: string; verifier: string | null; day: { used: number; cap: number; remaining: number }; month: { used: number; cap: number; scope: string }; note: string }

export default function EnrichmentPanel() {
  const [checks, setChecks] = useState<MailboxChecks | null>(null)
  useEffect(() => {
    void fetch('/api/settings/enrichment').then(r => r.ok ? r.json() : null).then(j => setChecks(j?.mailbox_checks ?? null)).catch(() => null)
  }, [])
  if (!checks || checks.state === 'off') return null
  return (
    <div className="card p-6 mb-4" data-testid="mailbox-checks" data-state={checks.state}>
      <h2 className="font-semibold mb-1">Email address checks</h2>
      <p className="text-[#555] text-sm mb-2">{checks.note}</p>
      <p className="text-xs text-[#555]" data-testid="mailbox-checks-numbers">
        Today: {checks.day.used} used{checks.day.cap > 0 ? ` of ${checks.day.cap}, ${checks.day.remaining} left` : ', no checks allowed (daily limit 0)'}.
        {' '}This month: {checks.month.used} used by this workspace{checks.verifier ? `; the monthly limit of ${checks.month.cap} is shared by all workspaces` : ''}.
      </p>
    </div>
  )
}
