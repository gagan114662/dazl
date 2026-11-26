'use client'
import { useEffect, useState } from 'react'
import { GMAIL_EXPLAINER_PATH } from '@/lib/auth-google-explainer'

interface RepliesInfo { available: boolean; consent: { version: string; text: string[]; accepted: boolean }; read_granted: boolean }

// Inline notice for pages that need Gmail reply access. Renders nothing once reading is on. The connect is send-only
// (#1603), so a mailbox without the old read grant is told plainly that replies are not read here; one that still has
// it (connected before #1603) is sent to Settings to accept the reply-reading terms.
export default function GmailGate({ intro }: { intro: string }) {
  const [i, setI] = useState<RepliesInfo | null>(null)
  // #1603 (Qodo): the unverified-app note below is only true until Google verifies the app; the settings
  // read carries that state (googleAppVerified on the server), so the note retires itself like the
  // connect page's does. Until the read lands, the note shows: the pre-verification default.
  const [verified, setVerified] = useState(false)
  useEffect(() => { fetch('/api/outreach/replies').then(r => r.ok ? r.json() : null).then(setI).catch(() => {}) }, [])
  useEffect(() => { fetch('/api/outreach/settings').then(r => r.ok ? r.json() : null).then(j => setVerified(j?.google_app_verified === true)).catch(() => {}) }, [])
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
  if (i.read_granted) return (
    <div className="card p-6 text-sm text-[#555]">
      Reply reading is off for this mailbox. <a className="underline underline-offset-2" href="/app/settings#replies">Turn it on in Settings</a>
    </div>
  )
  return (
    <div className="card p-6 text-sm text-[#555]" data-testid="gmail-send-only">
      <p>dazl connects to Gmail send-only, so it does not read replies. Replies and delivery-failure notices for the emails you send arrive in your own Gmail inbox.</p>
      {!verified && <p className="mt-2" data-testid="gmail-gate-verification-note">{'Connecting or reconnecting? dazl is waiting on Google\'s review of its app, so Google shows a warning that it has not verified this app. That is expected.'} <a className="underline underline-offset-2" href={GMAIL_EXPLAINER_PATH}>The connect page explains what to click</a> {'before you reach Google.'}</p>}
    </div>
  )
}
