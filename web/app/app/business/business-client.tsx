'use client'
// #1043: "Your business". Reads the stored business profile, Memory and Competitors (the same records every search and
// draft reads), shows them as sections with where each item came from, and edits them in place: the profile with the
// form below, Memory and Competitors with their own Settings editors. Suggested plays open Leads with the search filled
// in; nothing runs or is charged until the user presses Find leads there and sees the cost.
import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { businessPlays, businessSections, type BrainMemory, type BrainProfile, type BrainSection, type Source } from '@/lib/business-brain'
import type { Icp } from '@/lib/scan/icp'
import MemoryPanel from '../settings/memory-panel'
import CompetitorsPanel from '../settings/competitors-panel'

type Load = { profile: BrainProfile | null; memory: BrainMemory | null; competitors: string[] | null; failed: string[] }
const getJson = async (u: string) => { const r = await fetch(u); if (!r.ok) throw new Error(String(r.status)); return r.json() }
const lines = (v: string) => v.split('\n').map(x => x.trim()).filter(Boolean)

function SourceTag({ s }: { s: Source }) {
  if (s.kind === 'site') {
    let page = s.url
    try { const u = new URL(s.url); page = u.hostname + (u.pathname === '/' ? '' : u.pathname) } catch { /* shown as stored */ }
    return <a className="text-xs underline text-[#555] break-all" href={s.url} target="_blank" rel="noopener noreferrer" data-testid="source">from your site: {page}</a>
  }
  return <span className="text-xs text-[#555]" data-testid="source">{s.kind === 'profile' ? 'saved in your profile' : s.kind === 'memory' ? 'saved in Memory' : 'saved in Competitors'}</span>
}

function ProfileEditor({ profile, onSaved }: { profile: BrainProfile | null; onSaved: () => void }) {
  const b: Icp = profile?.buyer ?? { summary: '', who: [], industries: [], sizes: [], where: [], signals: [], exclude: [] }
  const [f, setF] = useState({ business_name: profile?.business_name ?? '', sells: profile?.sells ?? '', website: profile?.website ?? '', summary: b.summary, who: b.who.join('\n'), industries: b.industries.join('\n'), sizes: b.sizes.join('\n'), where: b.where.join('\n'), signals: b.signals.join('\n'), exclude: b.exclude.join('\n') })
  const [msg, setMsg] = useState(''); const [busy, setBusy] = useState(false)
  const input = 'w-full border border-black/15 rounded-lg px-3 py-2 text-sm bg-white'
  async function save() {
    setBusy(true); setMsg('')
    // the rest of the stored profile (research, window, country, lookalike...) is kept: only these fields change
    const buyer: Icp = { ...b, summary: f.summary.trim(), who: lines(f.who), industries: lines(f.industries), sizes: lines(f.sizes), where: lines(f.where), signals: lines(f.signals), exclude: lines(f.exclude) }
    const body: Record<string, unknown> = { business_name: f.business_name.trim(), sells: f.sells.trim(), buyer }
    if (f.website.trim()) body.website = f.website.trim()
    const r = await fetch('/api/settings/profile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null)
    setBusy(false)
    if (r?.ok) { setMsg('Saved. Your next searches and drafts use it.'); onSaved() }
    else setMsg((await r?.json().catch(() => null))?.error ?? 'Could not save. Try again.')
  }
  const row = (k: keyof typeof f, label: string, multi = false) => (
    <label className="block text-xs text-[#555] mb-2">{label}{multi ? ' (one per line)' : ''}
      {multi ? <textarea className={`${input} mt-1`} rows={2} value={f[k]} onChange={e => setF({ ...f, [k]: e.target.value })} />
        : <input className={`${input} mt-1`} value={f[k]} onChange={e => setF({ ...f, [k]: e.target.value })} />}
    </label>)
  return (
    <div className="mt-3 border-t border-black/10 pt-3" data-testid="profile-editor">
      {row('business_name', 'Company')}{row('sells', 'What you sell')}{row('website', 'Website (https://...)')}{row('summary', 'Who you sell to')}
      {row('who', 'Buyer roles', true)}{row('industries', 'Industries', true)}{row('sizes', 'Company sizes', true)}{row('where', 'Where', true)}
      {row('signals', 'Buying signals', true)}{row('exclude', 'Not a fit', true)}
      <button type="button" className="btn-primary btn-sm" disabled={busy} onClick={() => void save()}>{busy ? 'Saving...' : 'Save'}</button>
      {msg && <p className="text-sm mt-2" role="status">{msg}</p>}
    </div>)
}

function Section({ s, data, onSaved }: { s: BrainSection; data: Load; onSaved: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <section className="card p-5 mb-4" aria-labelledby={`h-${s.id}`} data-testid={`section-${s.id}`}>
      <div className="flex items-start justify-between gap-3">
        <h2 id={`h-${s.id}`} className="font-semibold">{s.title}</h2>
        <button type="button" className="btn-ghost btn-sm shrink-0" aria-expanded={open} onClick={() => { if (open) onSaved(); setOpen(!open) }}>{open ? 'Done' : 'Edit'}</button>
      </div>
      {s.items.length === 0 ? <p className="text-sm text-[#555] mt-2" data-testid="empty">dazl did not find this. {s.edit === 'profile' ? 'Add it with Edit.' : `Add it with Edit (saved in ${s.edit === 'memory' ? 'Memory' : 'Competitors'}).`}</p>
        : <ul className="mt-2 space-y-2">{s.items.map((it, i) => (
          <li key={i} className="text-sm min-w-0" data-testid="item">
            {it.label && <span className="text-[#555]">{it.label}: </span>}<span className="break-words">{it.text}</span>
            <div><SourceTag s={it.source} /></div>
          </li>))}</ul>}
      {open && (s.edit === 'profile' ? <ProfileEditor profile={data.profile} onSaved={onSaved} />
        : <div className="mt-3 border-t border-black/10 pt-3">{s.edit === 'memory' ? <MemoryPanel /> : <CompetitorsPanel />}</div>)}
    </section>)
}

export default function BusinessClient() {
  const [data, setData] = useState<Load | null>(null)
  const load = useCallback(async () => {
    const failed: string[] = []
    const [p, m, c] = await Promise.all([
      getJson('/api/settings/profile').catch(() => { failed.push('profile'); return null }),
      getJson('/api/settings/memory').then(j => j?.memory ?? null).catch(() => { failed.push('Memory'); return null }),
      getJson('/api/settings/competitors').then(j => Array.isArray(j?.competitors) ? j.competitors : null).catch(() => { failed.push('Competitors'); return null }),
    ])
    setData({ profile: p, memory: m, competitors: c, failed })
  }, [])
  useEffect(() => { queueMicrotask(() => void load()) }, [load])
  if (!data) return <div className="p-8 max-w-2xl"><p className="text-sm text-[#555]">Loading what dazl knows about your business...</p></div>
  const sections = businessSections(data.profile, data.memory, data.competitors)
  const plays = businessPlays(data.profile, data.competitors)
  return (
    <div className="p-4 sm:p-8 max-w-2xl">
      <h1 className="text-2xl font-semibold mb-1">Your business</h1>
      <p className="text-sm text-[#555] mb-5">What dazl knows about your business. Every search and draft starts from it; change anything that is wrong. Items from your website link to the page they came from.</p>
      {data.failed.length > 0 && <p className="text-sm mb-4" role="alert" data-testid="load-failed">Could not load your {data.failed.join(', ')}. Those sections may be incomplete; refresh to retry.</p>}
      <section className="card p-5 mb-6" aria-labelledby="h-plays" data-testid="plays">
        <h2 id="h-plays" className="font-semibold mb-2">Suggested plays</h2>
        {plays.length === 0 ? <p className="text-sm text-[#555]">Add buyer roles and a buying signal below and dazl will suggest plays from them.</p>
          : <><ul className="space-y-2">{plays.map(p => <li key={p.query}><Link className="underline break-words" href={`/app/leads?q=${encodeURIComponent(p.query)}`} data-testid="play">{p.query}</Link></li>)}</ul>
            <p className="text-xs text-[#555] mt-2">Opens Leads with this search filled in. Nothing runs until you press Find leads and see the cost.</p></>}
      </section>
      {sections.map(s => <Section key={s.id} s={s} data={data} onSaved={() => void load()} />)}
    </div>)
}
