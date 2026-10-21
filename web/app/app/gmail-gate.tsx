'use client'
import { useEffect, useState } from 'react'

interface RepliesInfo { available: boolean; consent: { version: string; text: string[]; accepted: boolean }; read_granted: boolean }

// Inline path for pages that need Gmail reply access: consent (with the real text) then
// the Connect Gmail button. Renders nothing once read access is granted.
export default function GmailGate({ intro }: { intro: string }) {
  const [i, setI] = useState<RepliesInfo | null>(null)
  useEffect(() => { fetch('/api/outreach/replies').then(r => r.ok ? r.json() : null).then(setI).catch(() => {}) }, [])
  // Fetch failed: fall back to pointing at Settings, never a blank page.
  if (!i) return (
    <div className="card p-6 text-sm text-[#555]">
      {intro} <a className="underline underline-offset-2" href="/app/settings">Open Settings</a>
    </div>
  )
  // Gmail is not wired up on this deployment yet: say so honestly instead of rendering nothing.
  if (!i.available) return (
    <div className="card p-6 text-sm text-[#555]">
      Reply reading is not available yet - dazl is still wiring up the Gmail connection. Nothing is wrong with your account; check back soon.
    </div>
  )
  if (i.consent.accepted && i.read_granted) return null
  return (
    <div className="card p-6 text-sm">
      <p className="font-medium mb-2">{intro}</p>
      <ul className="list-disc pl-5 text-[#555] mb-3">{i.consent.text.map((t, k) => <li key={k}>{t}</li>)}</ul>
      <a className="btn-primary inline-block" href="/api/gmail/connect">Connect Gmail</a>
      <p className="text-xs text-[#888] mt-2">Connecting means you agree to the reply-reading above. On Google&apos;s screen you can untick the read access and still connect send-only.</p>
    </div>
  )
}
