'use client'
import Link from 'next/link'
import { useEffect, useState } from 'react'

interface Step { n: string; t: string; d: string; href: string; cta: string }
const KEY_STEP: Step = { n: '1', t: 'Add your AI key', d: 'Scans run on your own Anthropic or OpenAI key.', href: '/app/settings', cta: 'Open Settings' }
const REST: Step[] = [
  { n: '2', t: 'Say who you want', d: 'One sentence. dazl builds the profile and you can edit it.', href: '/app/leads', cta: 'Go to Leads' },
  { n: '3', t: 'Review research and sources', d: 'Each lead links to its source and shows what was and was not confirmed. Check it yourself before contacting anyone.', href: '/app/leads', cta: 'See results' },
]

export default function HomeSteps() {
  const [state, setState] = useState<{ hasKey: boolean; remaining: number } | null>(null)
  const [gmailOk, setGmailOk] = useState<boolean | null>(null)
  useEffect(() => {
    void fetch('/api/usage').then(r => r.ok ? r.json() : null).then(j => {
      if (j) setState({ hasKey: !!j.has_key, remaining: j.trial?.remaining ?? 0 })
    }).catch(() => {})
  }, [])
  useEffect(() => { void fetch('/api/outreach/settings').then(r => r.ok ? r.json() : null).then(j => { if (j) setGmailOk(j.gmail?.status === 'active') }).catch(() => {}) }, [])
  // The key step shows only once the trial is used up (or the trial is off). While free scans
  // remain, the first-run path starts at "Say who you want".
  const onTrial = state && !state.hasKey && state.remaining > 0
  const steps: Step[] = [...(state === null || state.hasKey || onTrial ? (onTrial ? REST : [KEY_STEP, ...REST]) : [
    { ...KEY_STEP, d: `Your 3 free scans are used up. Add your own Anthropic or OpenAI key to keep scanning.` }, ...REST,
  ])]
  if (gmailOk === false) steps.push({ n: String(steps.length + 1), t: 'Connect Gmail to send', d: 'Signing in with Google does not connect Gmail. Connect it in Settings so dazl can send only the emails you approve, from your own Gmail. Reply reading is optional.', href: '/app/settings', cta: 'Open Settings' })
  return (
    <>
      {onTrial && (
        <p className="text-sm text-[#555] mb-4 border border-black/10 rounded-lg px-4 py-3 bg-[#fafafa]">
          Your first {state!.remaining} scan{state!.remaining === 1 ? '' : 's'} are on us - no AI key needed yet. Add your own key in Settings when they run out.
        </p>
      )}
      <div className="grid md:grid-cols-3 gap-4">
        {steps.map((s, i) => (
          <div key={s.t} className="card card-hover p-5 flex flex-col">
            <div className="w-7 h-7 rounded-full bg-black/5 text-[#111] text-xs font-semibold flex items-center justify-center mb-3">{i + 1}</div>
            <div className="font-semibold mb-1">{s.t}</div>
            <p className="text-[#555] text-sm mb-4 flex-1">{s.d}</p>
            <Link href={s.href} className="text-[#111] underline underline-offset-2 text-sm">{s.cta} &rarr;</Link>
          </div>
        ))}
      </div>
    </>
  )
}
