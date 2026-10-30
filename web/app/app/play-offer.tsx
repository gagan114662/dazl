'use client'
import { useState } from 'react'
import type { PlayOffer } from '@/lib/scan/play-offer-text'
import { inSentence } from '@/lib/offer-sentence'

// What THIS play sells (#349; lib/scan/play-offer.ts), shown wherever the play is: Home, its campaign page and its
// drafts. A play whose request names a different offer than the one it was created with shows both and waits for the
// tenant's choice; drafting for it is refused until then. Choosing changes this play only.
const SOURCE: Record<string, string> = {
  play: 'chosen for this play',
  recorded: 'recorded when this play started',
  profile: 'from your business profile',
  request: 'from this play\'s request',
}


// offer: undefined while loading (nothing shown), null when the play has no offer to show, 'unreadable' when the read
// failed: then the card says so rather than vanishing, so a play waiting for a choice is never shown as if it had none.
export function PlayOfferCard({ jobId, offer, onChange, compact }: { jobId: string; offer: PlayOffer | null | undefined | 'unreadable'; onChange?: (o: PlayOffer) => void; compact?: boolean }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  if (offer === undefined) return null
  async function choose(value: string) {
    setBusy(true); setMsg('')
    const r = await fetch(`/api/campaigns/${jobId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ offer: value }) }).catch(() => null)
    const j = await r?.json().catch(() => ({}))
    setBusy(false)
    if (!r?.ok || !j?.offer) return setMsg(j?.error || 'Could not save')
    setEditing(false)
    onChange?.(j.offer as PlayOffer)
  }
  const editor = <form className="mt-2 flex flex-col sm:flex-row gap-2" onSubmit={e => { e.preventDefault(); void choose(text) }}>
    <input className="field flex-1" aria-label="What this play sells" maxLength={150} value={text} onChange={e => setText(e.target.value)} placeholder="e.g. CRM setup and outbound consulting" data-testid="play-offer-input" />
    <div className="flex gap-2">
      <button className="btn-primary btn-sm" disabled={busy || text.trim().length < 3} data-testid="play-offer-save">{busy ? 'Saving...' : 'Save for this play'}</button>
      <button type="button" className="btn-ghost btn-sm" onClick={() => setEditing(false)}>Cancel</button>
    </div>
  </form>
  if (offer === null) return null
  if (offer === 'unreadable') return <p className="rounded-xl border border-[#e8b04a] bg-[#fff7e6] px-4 py-3 text-sm" role="alert" data-testid="play-offer-unreadable">What this play sells could not be loaded just now. Reload the page to see it before drafting.</p>
  if (offer.conflict) {
    const c = offer.conflict
    return <div className="rounded-xl border border-[#e8b04a] bg-[#fff7e6] px-4 py-3 text-sm" role="alert" data-testid="play-offer-conflict">
      <p className="font-semibold">Which offer is this play for?</p>
      {c.stated
        ? <p className="mt-1 text-[var(--ink-2)]">This play&apos;s request says you sell <strong>{inSentence(c.stated)}</strong>, but it started with <strong>{inSentence(c.recorded)}</strong>. dazl will not draft for it until you choose. Only this play changes.</p>
        : <p className="mt-1 text-[var(--ink-2)]" data-testid="play-offer-withdrawn">This play&apos;s request says you do not offer <strong>{inSentence(c.withdrawn ?? '')}</strong>, but it started with <strong>{inSentence(c.recorded)}</strong>. dazl will not draft for it until you say what it sells. Only this play changes.</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        {c.stated && <button className="btn-primary btn-sm" disabled={busy} onClick={() => void choose(c.stated!)} data-testid="play-offer-use-stated">Use: {c.stated}</button>}
        <button className="btn-ghost btn-sm" disabled={busy} onClick={() => void choose(c.recorded)} data-testid="play-offer-use-recorded">Keep: {c.recorded}</button>
        {!editing && <button className={c.stated ? 'btn-ghost btn-sm' : 'btn-primary btn-sm'} onClick={() => { setText(''); setEditing(true) }} data-testid="play-offer-write">{c.stated ? 'Something else' : 'Write what this play sells'}</button>}
      </div>
      {editing && editor}
      {msg && <p className="mt-1 text-xs" role="status">{msg}</p>}
    </div>
  }
  return <div className={compact ? 'text-sm' : 'rounded-xl bg-[#f6f0ea] px-4 py-3 text-sm'} data-testid="play-offer">
    <div className="flex flex-wrap items-baseline gap-x-2">
      <span className="text-xs font-semibold uppercase tracking-wide text-[var(--ink-3)]">This play sells</span>
      <span className="font-medium" data-testid="play-offer-text">{offer.offer ?? 'Not set yet'}</span>
      {offer.offer && <span className="text-xs text-[var(--ink-3)]">({SOURCE[offer.source] ?? offer.source})</span>}
      {!editing && <button type="button" className="text-xs underline text-[var(--ink-2)]" onClick={() => { setText(offer.offer ?? ''); setEditing(true) }} data-testid="play-offer-change">Change</button>}
    </div>
    {editing && editor}
    {msg && <p className="mt-1 text-xs" role="status">{msg}</p>}
  </div>
}
