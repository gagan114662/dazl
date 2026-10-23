'use client'
import { useEffect, useState } from 'react'

interface Attempt { vendor: string | null; model: string | null; outcome: string; input_tokens: number | null; output_tokens: number | null; created_at: number }

const OUTCOME: Record<string, string> = {
  rewritten: 'rewrite kept',
  unusable: 'rewrite discarded (unusable output)',
  blocked_claim: 'rewrite discarded (asserted an unverified claim)',
  error: 'failed',
  no_key: 'no AI key on file',
  no_profile: 'refused - no positioning in Memory',
}

export default function UsagePanel() {
  const [attempts, setAttempts] = useState<Attempt[]>([])
  const [total, setTotal] = useState(0)
  useEffect(() => {
    void fetch('/api/outreach/usage').then(r => r.ok ? r.json() : null).then(j => { if (j) { setAttempts(j.attempts); setTotal(j.total) } })
  }, [])
  return (
    <div className="card p-6 mb-4">
      <h2 className="font-semibold mb-1">AI rewrite attempts</h2>
      <p className="text-[#555] text-sm mb-4">Every AI rewrite click is listed here with what your provider reported back. Token counts are provider-reported usage, not a cost estimate - your provider bills you directly and its console has the amounts.</p>
      {total === 0 ? <p className="text-sm text-[#666]">No AI rewrite attempts yet.</p> : (
        <>
          <p className="text-sm mb-3">{total} attempt{total === 1 ? '' : 's'} (newest first)</p>
          <div className="flex flex-col gap-2">
            {attempts.map((a, i) => (
              <div key={i} className="text-xs text-[#333] flex flex-wrap gap-x-3">
                <span>{new Date(a.created_at * 1000).toLocaleString()}</span>
                <span>{a.vendor ?? 'no key'}{a.model ? ` · ${a.model}` : ''}</span>
                <span>{OUTCOME[a.outcome] ?? a.outcome}</span>
                {a.input_tokens != null && <span>{a.input_tokens} in / {a.output_tokens ?? '?'} out tokens</span>}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
