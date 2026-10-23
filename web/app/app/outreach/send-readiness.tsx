'use client'
import { useEffect, useState } from 'react'

interface S { gmail: { email: string; status: string; read_granted: boolean } | null; sender: { sender_name: string; postal_address: string } | null }

// Plain status of what is needed before anything can be sent. Signing in with Google proves identity only;
// Gmail is a separate, explicit grant made in Settings, so say so rather than leaving the user to find out at Send.
export default function SendReadiness() {
  const [s, setS] = useState<S | null>(null)
  useEffect(() => { fetch('/api/outreach/settings').then(r => r.ok ? r.json() : null).then(setS).catch(() => {}) }, [])
  if (!s) return null
  const gmailOk = s.gmail?.status === 'active'
  const senderOk = !!s.sender?.sender_name && !!s.sender?.postal_address
  if (gmailOk && senderOk) return <p className="text-xs text-[#666] mb-4">Ready to send from {s.gmail!.email}. Every email still needs your approval. Reply reading is {s.gmail!.read_granted ? 'on' : 'off (optional)'}.</p>
  return (
    <div className="card p-4 mb-4 text-sm">
      <p className="font-medium mb-1">Not ready to send yet</p>
      <ul className="list-disc pl-5 text-[#555] mb-2">
        {!s.gmail && <li>Gmail is not connected. Signing in with Google does not connect Gmail; it is a separate step you approve in Settings.</li>}
        {s.gmail && !gmailOk && <li>Gmail needs reconnecting.</li>}
        {!senderOk && <li>Add your name and mailing address.</li>}
      </ul>
      <a className="underline underline-offset-2" href="/app/settings">Open Settings</a>
    </div>
  )
}
