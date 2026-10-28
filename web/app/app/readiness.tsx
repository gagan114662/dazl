'use client'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import KeyInline from './key-inline'
import SenderInline from './sender-inline'
import { normalizeWebsite } from '@/lib/onboarding'
import { capNotice, readinessRows, recentPlays, type ReadinessInput, type Play } from '@/lib/readiness'

// Home after the first search: the steps left before a useful scan and send, each with its fix (in place, or a link to
// the page that fixes it). Gmail stays in Settings: connecting is an explicit Google grant whose read-access terms are
// explained there. The checklist is hidden once every step is done; the plays stay.
export default function Readiness() {
  const [input, setInput] = useState<ReadinessInput | null>(null)
  const [plays, setPlays] = useState<Play[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [reopened, setReopened] = useState(false) // the finished checklist, shown again on request
  const [site, setSite] = useState({ website: '', sells: '', business_name: '' })
  const [siteMsg, setSiteMsg] = useState('')

  async function load() {
    const get = (u: string) => fetch(u).then(r => r.ok ? r.json() : null).catch(() => null)
    const [profile, usage, outreach, jobs, sources, keys, advanced, emails, campaigns] = await Promise.all([get('/api/settings/profile'), get('/api/usage'), get('/api/outreach/settings'), get('/api/scan/jobs'), get('/api/scan/sources'), get('/api/settings/llm-key'), get('/api/settings/advanced'), get('/api/outreach'), get('/api/campaigns')])
    setInput({ profile, usage, outreach, jobs: jobs?.jobs ?? null, sources, keys: Array.isArray(keys?.keys) ? keys.keys : null, rejection: Array.isArray(keys?.keys) && keys.rejection && typeof keys.rejection === 'object' ? keys.rejection : null, advanced: advanced && Array.isArray(advanced.platforms) ? advanced : null, messages: Array.isArray(emails?.messages) ? emails.messages : null, campaigns: Array.isArray(campaigns?.campaigns) ? campaigns.campaigns : null })
    setPlays(jobs?.jobs ? recentPlays(jobs.jobs) : null)
    if (profile) setSite({ website: String(profile.website ?? ''), sells: String(profile.sells ?? ''), business_name: String(profile.business_name ?? '') })
  }
  useEffect(() => {
    void load() // eslint-disable-line react-hooks/set-state-in-effect
    const refresh = () => void load()
    window.addEventListener('profile-updated', refresh) // the Home setup steps saved the business or buyer profile
    return () => window.removeEventListener('profile-updated', refresh)
  }, [])

  async function saveSite(e: React.FormEvent) {
    e.preventDefault(); setSiteMsg('')
    // Only the seller fields: the saved buyer profile is left as it is (omitted fields keep their stored value).
    const r = await fetch('/api/settings/profile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ website: normalizeWebsite(site.website), sells: site.sells, business_name: site.business_name }) }).catch(() => null)
    const j = await r?.json().catch(() => ({}))
    if (!r?.ok) return setSiteMsg(j?.error || 'Could not save')
    setOpen(null); void load()
  }

  if (!input) return null
  const rows = readinessRows(input)
  const done = rows.filter(r => r.state === 'done').length
  const capped = capNotice(input.outreach)
  return (
    <section className="mb-10">
      {capped && <p role="status" data-testid="cap-notice" className="card p-4 mb-6 text-sm border-l-2 border-black">{capped} <Link className="underline" href="/app/outreach">Outreach</Link></p>}
      {done === rows.length && !reopened && <p className="text-sm text-[#555] mb-6" data-testid="ready-all-done">Setup checklist: all {rows.length} steps done. <button type="button" className="underline" onClick={() => setReopened(true)}>Show it</button></p>}
      {(done < rows.length || reopened) && <div data-testid="readiness-checklist">
      <h2 id="ready-heading" className="text-lg font-semibold mb-1">Before your first scan and send</h2>
      <p className="text-sm text-[#555] mb-3" data-testid="ready-progress">{done} of {rows.length} done</p>
      <ul className="card divide-y divide-black/10" aria-labelledby="ready-heading">
        {rows.map(r => (
          <li key={r.id} className={`p-4 text-sm ${r.next ? 'border-l-2 border-black bg-black/[0.03]' : ''}`} data-testid={`ready-${r.id}`} data-next={r.next ? 'true' : undefined}>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <span aria-hidden className={`inline-block w-5 mr-2 font-semibold ${r.state === 'done' ? '' : 'text-[#999]'}`}>{r.state === 'done' ? '✓' : r.state === 'unknown' ? '?' : '○'}</span>
                {r.next && <span className="text-[10px] uppercase tracking-wide border border-black px-1 py-0.5 mr-2" data-testid="next-step-tag">Next step</span>}
                <span className="font-medium">{r.label}</span>
                <span className="text-[#555]"> - {r.detail}</span>
              </div>
              {/* A done row has a fix only when part of it is still optional to set up (a lead source that is not available). */}
              {r.fix && (r.fix.kind === 'link'
                // A same-page link with ?setup= must load the page (the setup steps read it once, on load).
                ? r.fix.href.includes('?setup=') ? <a href={r.fix.href} className={`${r.next ? 'btn-primary' : 'btn-ghost'} text-xs px-3 py-1.5 shrink-0`}>{r.fix.label}</a>
                  : <Link href={r.fix.href} className={`${r.next ? 'btn-primary' : 'btn-ghost'} text-xs px-3 py-1.5 shrink-0`}>{r.fix.label}</Link>
                : <button type="button" className={`${r.next ? 'btn-primary' : 'btn-ghost'} text-xs px-3 py-1.5 shrink-0`} aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)}>{r.fix.label}</button>)}
            </div>
            {open === r.id && r.id === 'site' && <form onSubmit={saveSite} className="mt-3 flex flex-col gap-2">
              <input className="field" aria-label="Business name" required maxLength={150} placeholder="Business name (used in your email drafts)" value={site.business_name} onChange={e => setSite({ ...site, business_name: e.target.value })} />
              <input className="field" aria-label="Your website" placeholder="acme.com" value={site.website} onChange={e => setSite({ ...site, website: e.target.value })} />
              <input className="field" aria-label="What you sell" required minLength={3} maxLength={150} placeholder="What you sell, in one line" value={site.sells} onChange={e => setSite({ ...site, sells: e.target.value })} />
              <div className="flex gap-3 items-center"><button className="btn-primary text-xs px-3 py-1.5">Save</button>{siteMsg && <span className="text-xs" role="status">{siteMsg}</span>}</div>
            </form>}
            {open === r.id && r.id === 'key' && <div className="mt-3"><KeyInline reason="Searches and website reads run on your own Anthropic or OpenAI key." onSaved={() => { setOpen(null); void load() }} /></div>}
            {open === r.id && r.id === 'sender' && <div className="mt-3"><SenderInline initial={input.outreach?.sender ?? null} onSaved={() => { setOpen(null); void load() }} /></div>}
          </li>
        ))}
      </ul>
      </div>}

      {/* No plays yet: nothing to list (the First play row and the setup steps below point to the first one). */}
      {(plays === null || plays.length > 0) && <h2 className={`text-lg font-semibold mb-3 ${done < rows.length ? 'mt-8' : ''}`}>Your plays</h2>}
      {plays === null ? <p className="text-sm text-[#555]">Could not load your searches. Reload to retry.</p>
        : plays.length === 0 ? null
        : <ul className="card divide-y divide-black/10" aria-label="Your plays">
          {plays.map(p => <li key={p.id} className="p-4 text-sm flex items-center justify-between gap-3">
            {/* The play opens its campaign page (play, leads, drafts and sends together); the outcome opens its leads. */}
            <Link className="min-w-0 truncate hover:underline" title={`${p.query} - campaign page`} href={`/app/campaigns/${p.id}`} data-testid="play-campaign-link">{p.query}</Link>
            <Link className="underline shrink-0" href={`/app/leads?job_id=${p.id}`}>{p.outcome}</Link>
          </li>)}
        </ul>}
    </section>
  )
}
