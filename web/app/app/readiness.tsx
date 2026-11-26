'use client'
import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import KeyInline from './key-inline'
import SenderInline from './sender-inline'
import { normalizeWebsite } from '@/lib/onboarding'
import { Icon } from './ui/icons'
import { Pill } from './ui/bits'
import { loadReadinessInput } from './readiness-input'
import { subscribeFocusRefresh } from '@/lib/focus-refresh'
import { homePlays, readinessRows, type ReadinessInput, type HomePlay } from '@/lib/readiness'

// Home after the first search: the steps left before a useful scan and send, each with its fix (in place, or a link to
// the page that fixes it). Gmail stays in Settings: connecting is an explicit Google grant whose read-access terms are
// explained there. The checklist is hidden once every step is done; the plays stay.
const HOME_PLAYS = 5
// The play opens its campaign page (play, leads, drafts and sends together); the outcome opens its leads.
const playCard = (p: HomePlay) => <li key={p.key} className="card p-4 text-sm flex flex-col gap-3" data-testid="home-play" data-kind={p.kind}>
  <Link className="font-semibold leading-snug line-clamp-2 hover:underline" title={`${p.query} - campaign page`} href={p.campaignHref} data-testid="play-campaign-link">{p.query}</Link>
  <Link className="pill pill-plain self-start mt-auto" href={p.outcomeHref}>{p.outcome}</Link>
</li>

export default function Readiness() {
  const [input, setInput] = useState<ReadinessInput | null>(null)
  const [plays, setPlays] = useState<HomePlay[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [reopened, setReopened] = useState(false) // the finished checklist, shown again on request
  const [site, setSite] = useState({ website: '', sells: '', business_name: '' })
  const [siteMsg, setSiteMsg] = useState('')

  const loadSeqRef = useRef(0)
  const siteSeededRef = useRef(false) // the form was filled from a profile read at least once
  // #1760: dirty is tracked PER FIELD: one edited field must not stop the seed from filling the others, or the
  // untouched ones keep their empty initial state and a save posts that over the stored profile (data loss).
  const siteDirtyRef = useRef<Record<'website' | 'sells' | 'business_name', boolean>>({ website: false, sells: false, business_name: false })
  const editSite = (k: 'website' | 'sells' | 'business_name', v: string) => { siteDirtyRef.current[k] = true; setSite(cur => ({ ...cur, [k]: v })) }
  async function load(refreshSite = true, fresh = false) {
    // #1471: the plays are GET /api/plays, the same list the Plays page shows; each row's outcome comes from the jobs read
    // #1722: overlapping loads (mount vs wake) apply in start order - a slow earlier read must not revert a newer status.
    const seq = ++loadSeqRef.current
    const [{ input: next, jobs }, listed] = await Promise.all([loadReadinessInput({ fresh }), fetch('/api/plays').then(r => r.ok ? r.json() : null).catch(() => null)])
    const profile = next.profile
    // The form seeds once from a profile read, and only over untouched input: a wake re-read (refreshSite=false)
    // can win the race and never seeds it, so a discarded older read still applies the seed - otherwise the form
    // keeps its empty initial state and a save would post those empty fields over the stored profile (#1760).
    const seedSite = () => {
      if (!profile) return
      siteSeededRef.current = true
      const next = { website: String(profile.website ?? ''), sells: String(profile.sells ?? ''), business_name: String(profile.business_name ?? '') }
      setSite(cur => ({
        website: siteDirtyRef.current.website ? cur.website : next.website,
        sells: siteDirtyRef.current.sells ? cur.sells : next.sells,
        business_name: siteDirtyRef.current.business_name ? cur.business_name : next.business_name,
      }))
    }
    if (seq !== loadSeqRef.current) { if (refreshSite && !siteSeededRef.current) seedSite(); return }
    setInput(next)
    setPlays(listed && Array.isArray(listed.plays) ? homePlays(listed.plays, jobs ?? null, next.campaigns) : null)
    // #1722: a wake re-read refreshes the status only - never the form state, so unsaved input survives.
    if (refreshSite) seedSite()
  }
  useEffect(() => {
    void load()
    const refresh = () => void load(true, true) // a save starts a new read, never joins one in flight (#1880)
    window.addEventListener('profile-updated', refresh) // the Home setup steps saved the business or buyer profile
    // #1722: the sender status can change in another tab (Outreach); re-read when this tab is used again.
    // #1876: one shared listener for the page, so a focus refreshes once instead of once per panel and event.
    const offWake = subscribeFocusRefresh(() => void load(false, true))
    return () => { window.removeEventListener('profile-updated', refresh); offWake() }
  }, [])

  async function saveSite(e: React.FormEvent) {
    e.preventDefault(); setSiteMsg('')
    // Only the seller fields: the saved buyer profile is left as it is (omitted fields keep their stored value).
    const r = await fetch('/api/settings/profile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ website: normalizeWebsite(site.website), sells: site.sells, business_name: site.business_name }) }).catch(() => null)
    const j = await r?.json().catch(() => ({}))
    if (!r?.ok) return setSiteMsg(j?.error || 'Could not save')
    siteDirtyRef.current = { website: false, sells: false, business_name: false } // the saved profile is now what the form shows
    setOpen(null); void load()
  }

  if (!input) return null
  const rows = readinessRows(input)
  const done = rows.filter(r => r.state === 'done').length
  return (
    <section className="mb-10">
      {done === rows.length && !reopened && <div className="card px-4 py-3 text-sm mb-6 flex items-center gap-3"><span aria-hidden className="step-dot bg-[var(--mint)] text-white">✓</span><p className="flex-1 flex items-center justify-between gap-3" data-testid="ready-all-done"><span>Setup checklist: all {rows.length} steps done.</span> <button type="button" className="btn-ghost btn-sm" onClick={() => setReopened(true)}>Show it</button></p></div>}
      {(done < rows.length || reopened) && <div data-testid="readiness-checklist" className="card overflow-hidden">
      <div className="p-5 pb-4">
        <div className="flex items-center justify-between gap-3">
          <h2 id="ready-heading" className="text-lg font-bold tracking-tight">Get set up</h2>
          <span className="text-sm font-semibold text-[var(--ink-2)]" data-testid="ready-progress">{done} of {rows.length} done</span>
        </div>
        <div className="mt-3 h-2 rounded-full bg-[#ececec] overflow-hidden" aria-hidden><div className="h-full rounded-full bg-[var(--ink)]" style={{ width: `${Math.round(done / rows.length * 100)}%` }} /></div>
      </div>
      <ul className="divide-y divide-[var(--line)] border-t border-[var(--line)]" aria-labelledby="ready-heading">
        {rows.map(r => (
          <li key={r.id} className={`px-5 py-3.5 text-sm ${r.next ? 'bg-[var(--lav-bg)]' : ''}`} data-testid={`ready-${r.id}`} data-next={r.next ? 'true' : undefined}>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 flex items-start gap-3">
                <span aria-hidden className={`step-dot shrink-0 ${r.state === 'done' ? 'bg-[var(--mint)] text-white' : r.next ? 'bg-[var(--lav)] text-white' : 'bg-[#efefef] text-[var(--ink-3)]'}`}>{r.state === 'done' ? '✓' : r.state === 'unknown' ? '?' : ''}</span>
                <span className="min-w-0">
                  <span className="font-semibold">{r.label}</span><span className="sr-only"> - </span>
                  <span className="block text-xs text-[var(--ink-2)] mt-0.5">{r.detail}</span>
                </span>
              </div>
              {r.next && <span className="ml-auto shrink-0 hidden sm:inline" data-testid="next-step-tag"><Pill tone="lav">Next step</Pill></span>}
              {/* A done row has a fix only when part of it is still optional to set up (a lead source that is not available). */}
              {r.fix && (r.fix.kind === 'link'
                // A same-page link with ?setup= must load the page (the setup steps read it once, on load).
                ? r.fix.href.includes('?setup=') ? <a href={r.fix.href} className={`${r.next ? 'btn-primary' : 'btn-ghost'} btn-sm shrink-0`}>{r.fix.label}</a>
                  : <Link href={r.fix.href} className={`${r.next ? 'btn-primary' : 'btn-ghost'} btn-sm shrink-0`}>{r.fix.label}</Link>
                : <button type="button" className={`${r.next ? 'btn-primary' : 'btn-ghost'} btn-sm shrink-0`} aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)}>{r.fix.label}</button>)}
            </div>
            {open === r.id && r.id === 'site' && <form onSubmit={saveSite} className="mt-3 flex flex-col gap-2">
              <input className="field" aria-label="Business name" required maxLength={150} placeholder="Business name (used in your email drafts)" value={site.business_name} onChange={e => editSite('business_name', e.target.value)} />
              <input className="field" aria-label="Your website" placeholder="acme.com" value={site.website} onChange={e => editSite('website', e.target.value)} />
              <input className="field" aria-label="What you sell" required minLength={3} maxLength={150} placeholder="What you sell, in one line" value={site.sells} onChange={e => editSite('sells', e.target.value)} />
              <div className="flex gap-3 items-center"><button className="btn-primary text-xs px-3 py-1.5">Save</button>{siteMsg && <span className="text-xs" role="status">{siteMsg}</span>}</div>
            </form>}
            {open === r.id && r.id === 'key' && <div className="mt-3"><KeyInline reason="Searches and website reads run on Claude, with your own Anthropic key." onSaved={() => { setOpen(null); void load() }} /></div>}
            {open === r.id && r.id === 'sender' && <div className="mt-3"><SenderInline initial={input.outreach?.sender ?? null} onSaved={() => { setOpen(null); void load() }} /></div>}
          </li>
        ))}
      </ul>
      </div>}

      {/* No plays yet: nothing to list (the First play row and the setup steps below point to the first one). */}
      {(plays === null || plays.length > 0) && <div className={`flex items-center justify-between mb-3 ${done < rows.length || reopened ? 'mt-8' : ''}`}><h2 className="text-lg font-bold tracking-tight">Your plays</h2><Link className="btn-primary btn-sm" href="/app/leads"><Icon name="spark" className="w-3.5 h-3.5" />New play</Link></div>}
      {plays === null ? <p className="text-sm text-[var(--ink-2)]">Could not load your searches. Reload to retry.</p>
        : plays.length === 0 ? null
        : <>
          {/* #1471: every play the Plays page lists is here too, newest first: the first HOME_PLAYS shown, the rest one click away */}
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="Your plays">{plays.slice(0, HOME_PLAYS).map(playCard)}</ul>
          {plays.length > HOME_PLAYS && <details className="mt-3" data-testid="home-plays-more">
            <summary className="text-sm cursor-pointer">Show all {plays.length} plays</summary>
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 mt-3" aria-label="More plays">{plays.slice(HOME_PLAYS).map(playCard)}</ul>
          </details>}
        </>}
    </section>
  )
}
