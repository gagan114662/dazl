'use client'
import { useEffect, useState } from 'react'
import { previewSplit, type PreviewLead } from '@/lib/journey'
import { approveState, leadCardSummary } from '@/lib/scan/lead-card'
import SenderInline from '../sender-inline'
import { Avatar, Pill } from '../ui/bits'

// After the first lead cards: review them one at a time and start outreach, the way Pancake asks you to approve each lead
// before it writes. Approve is the existing draft action (POST /api/outreach { lead_id }), so every server check still
// decides; a lead a check holds says why and is never approved from here. Nothing is sent from this screen: drafts wait
// in Outreach. Then the two things sending needs: Gmail (one click, with the read notice it accepts) and the sender name
// and mailing address every email carries.
interface Settings { gmail: { email?: string; status?: string } | null; sender: { sender_name?: string; postal_address?: string; booking_url?: string | null } | null; read_notice?: string[] }
type Verdict = 'approved' | 'skipped'

export default function FirstReview({ jobId }: { jobId: string }) {
  const [leads, setLeads] = useState<PreviewLead[] | null | 'failed'>(null)
  const [at, setAt] = useState(0)
  const [verdict, setVerdict] = useState<Record<string, Verdict>>({})
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [settings, setSettings] = useState<Settings | null>(null)
  const loadSettings = () => void fetch('/api/outreach/settings').then(r => r.ok ? r.json() : null).catch(() => null).then(setSettings)
  useEffect(() => {
    void fetch(`/api/leads?job_id=${jobId}`).then(r => r.ok ? r.json() : null).catch(() => null).then(j => setLeads(Array.isArray(j?.leads) ? previewSplit(j.leads as PreviewLead[]).opportunities : 'failed'))
    loadSettings()
  }, [jobId])

  if (leads === null) return <p className="text-center text-[var(--ink-2)]" data-testid="review-loading">Loading your leads...</p>
  if (leads === 'failed') return <p className="text-center" role="alert">Could not load your leads. <a className="underline" href={`/app/leads?job_id=${jobId}`}>Open them in Leads</a></p>

  const approved = leads.filter(l => verdict[l.id] === 'approved').length
  const done = at >= leads.length
  const l = done ? null : leads[at]

  async function approve(id: string) {
    setBusy(true); setErr('')
    try {
      const r = await fetch('/api/outreach', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lead_id: id }) })
      const j = await r.json().catch(() => ({}))
      // The server's own refusal is shown on the card; the lead stays where it is.
      if (!r.ok) return setErr(j.error || 'Could not create the draft.')
      setVerdict(v => ({ ...v, [id]: 'approved' })); setAt(n => n + 1)
    } catch { setErr('Could not reach the server. Try again.') } finally { setBusy(false) }
  }
  const skip = (id: string) => { setErr(''); setVerdict(v => ({ ...v, [id]: 'skipped' })); setAt(n => n + 1) }

  const gmailOn = settings?.gmail?.status === 'active'
  const senderOn = !!settings?.sender?.sender_name && !!settings?.sender?.postal_address
  return (
    <div className="w-full max-w-3xl" data-testid="review-step">
      <div className="text-center">
        <h1 className="text-3xl sm:text-[44px] leading-tight font-bold tracking-tight text-[#2a0a24]">{done ? (approved ? `${approved} draft${approved === 1 ? '' : 's'} ready for you` : 'Nothing approved yet') : 'Review your first leads'}</h1>
        <p className="text-[var(--ink-2)] mt-2" data-testid="review-subhead">{done
          ? (approved ? 'Each one waits in Outreach for you to read and approve, unless you turn on Autopilot.' : 'Skipped leads stay in Leads; you can come back to them.')
          : 'Approve the ones worth writing to and dazl drafts the email. Nothing is sent from here.'}</p>
      </div>

      {!done && l && (() => {
        const c = leadCardSummary(l), ok = approveState(l)
        return <section className="onb-card p-5 sm:p-7 mt-7" data-testid="review-card" aria-label={`Lead ${at + 1} of ${leads.length}`}>
          <div className="flex items-center justify-between text-xs text-[var(--ink-3)] mb-4"><span data-testid="review-count">{at + 1} of {leads.length}</span>{l.fit != null && <Pill tone="mint">fit {l.fit}/5</Pill>}</div>
          <div className="flex items-start gap-3 min-w-0">
            <Avatar name={c.company} size={44} />
            <div className="min-w-0">
              <div className="font-bold text-lg leading-tight break-words">{c.company}</div>
              <div className="text-sm text-[var(--ink-2)] mt-0.5 break-words" data-testid="review-contact">{c.contact ?? 'No contact found yet'}</div>
            </div>
          </div>
          <p className="mt-4 font-semibold leading-snug break-words">{c.why}</p>
          {l.evidence_excerpt && <blockquote className="mt-3 border-l-2 border-[var(--mint)] pl-3 text-sm break-words" data-testid="review-quote">&ldquo;{l.evidence_excerpt}&rdquo;</blockquote>}
          <p className="text-xs mt-3 flex flex-wrap gap-2"><a className="pill pill-plain" href={c.sourceUrl} target="_blank" rel="noopener noreferrer nofollow">{c.sourceHost}</a><span className="pill pill-plain">{c.date}</span></p>
          {err && <p className="text-sm mt-3 text-[#a3173f]" role="alert" data-testid="review-error">{err}</p>}
          {!ok.ok && <p className="text-sm mt-4 text-[var(--ink-2)]" data-testid="review-held">Can&apos;t approve yet: {ok.reason} <a className="underline" href={`/app/leads?job_id=${jobId}`}>Open it in Leads</a></p>}
          <div className="mt-5 flex flex-wrap gap-2">
            <button type="button" className="btn-primary btn-lg" disabled={busy || !ok.ok} onClick={() => void approve(l.id)}>{busy ? 'Drafting...' : 'Approve and draft'}</button>
            <button type="button" className="btn-ghost btn-lg" disabled={busy} onClick={() => skip(l.id)}>Skip</button>
          </div>
          <p className="text-xs text-[var(--ink-3)] mt-3">Approve drafts an email to this contact from the evidence above. You read and approve it in Outreach before it sends, unless you turn on Autopilot.</p>
        </section>
      })()}

      {(done || approved > 0) && <section className="onb-card p-5 sm:p-7 mt-5" data-testid="send-setup" aria-label="Before you send">
        <h2 className="text-xl font-bold tracking-tight">Before your first email sends</h2>
        <div className="mt-4 grid gap-4">
          <div data-testid="setup-gmail">
            <div className="font-semibold text-sm">{gmailOn ? '✓ Gmail connected' : 'Connect Gmail'}</div>
            {gmailOn ? <p className="text-sm text-[var(--ink-2)]">Sending from {settings?.gmail?.email}</p> : <>
              {/* Connecting accepts this notice (the connect route records it), so it is shown right here, as in Settings. */}
              {settings?.read_notice && settings.read_notice.length > 0 && <ul className="list-disc pl-5 text-xs text-[var(--ink-2)] mt-1 space-y-0.5" data-testid="read-notice">{settings.read_notice.map((t, k) => <li key={k}>{t}</li>)}</ul>}
              <a href="/api/gmail/connect" className="btn-ghost btn-sm mt-2 inline-flex" data-testid="connect-gmail">Connect Gmail</a>
              <p className="text-xs text-[var(--ink-3)] mt-1">Connecting means you agree to the reply-reading above. Google brings you back to Settings; your drafts wait in Outreach.</p>
            </>}
          </div>
          <div data-testid="setup-sender">
            <div className="font-semibold text-sm">{senderOn ? `✓ Sender: ${settings?.sender?.sender_name}` : 'Your name and mailing address'}</div>
            {!senderOn && settings && <div className="mt-2"><SenderInline initial={settings.sender} onSaved={loadSettings} /></div>}
          </div>
        </div>
        {approved > 0 && <a className="btn-primary btn-lg w-full justify-center mt-6" href={`/app/outreach?job_id=${jobId}`} data-testid="review-drafts">Review your {approved} draft{approved === 1 ? '' : 's'}</a>}
      </section>}
    </div>
  )
}
