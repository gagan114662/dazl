// #1043: "Your business" - what dazl knows about the customer's business, on one page, built ONLY from what is already
// stored (the business profile, Memory, Competitors) and never padded. Pure and client-safe: no network, no model call.
//
// Provenance is told exactly as stored:
//  - "from your site" (with the page) only for a source-backed item the website read recorded (#379 research: an item
//    with a URL whose status is sourced or reviewed);
//  - everything else says where it is saved ("your profile", "Memory", "Competitors"), never "from your site", because
//    the flat profile fields keep no per-item source.
// A section with nothing in it says so ("dazl did not find this"); nothing is invented to fill it.
import type { Icp, ResearchedHyp } from './scan/icp.ts'

export interface BrainProfile { business_name?: string | null; sells?: string | null; website?: string | null; buyer?: Icp | null }
export interface BrainMemory { icp?: string; positioning?: string; tone?: string; exclusions?: string[]; objections?: { q: string; a: string }[] }
export type Source = { kind: 'site'; url: string } | { kind: 'profile' } | { kind: 'memory' } | { kind: 'competitors' }
export interface BrainItem { label?: string; text: string; source: Source }
export interface BrainSection { id: 'company' | 'customer' | 'roles' | 'signals' | 'competitors' | 'objections' | 'voice'; title: string; items: BrainItem[]; edit: 'profile' | 'memory' | 'competitors' }

const clean = (s: unknown) => typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : ''
const list = (a: unknown) => Array.isArray(a) ? a.map(clean).filter(Boolean) : []
const httpsUrl = (u: unknown) => typeof u === 'string' && /^https:\/\/[^\s]{4,500}$/.test(u) ? u : null

// Only a source-backed research item with a page earns "from your site"; hypotheses and rejected items do not.
function siteItems(research: Icp['research'], kinds: ResearchedHyp['k'][]): BrainItem[] {
  const hyps = Array.isArray(research?.hyps) ? research!.hyps : []
  return hyps.filter(h => kinds.includes(h.k) && (h.s === 'sourced' || h.s === 'reviewed') && httpsUrl(h.u) && clean(h.t))
    .map(h => ({ text: clean(h.t), source: { kind: 'site' as const, url: h.u! } }))
}
// The same text twice (a profile field that a research item also backs) is shown once, with its site source.
function merge(...groups: BrainItem[][]): BrainItem[] {
  const out: BrainItem[] = []
  for (const it of groups.flat()) {
    const k = `${it.label ?? ''}|${it.text.toLowerCase()}`
    const at = out.findIndex(o => `${o.label ?? ''}|${o.text.toLowerCase()}` === k)
    if (at < 0) out.push(it)
    else if (it.source.kind === 'site' && out[at].source.kind !== 'site') out[at] = it
  }
  return out
}

export function businessSections(p: BrainProfile | null, m: BrainMemory | null, competitors: string[] | null): BrainSection[] {
  const b = p?.buyer ?? null
  const prof = { kind: 'profile' as const }, mem = { kind: 'memory' as const }
  const field = (label: string, v: unknown, source: Source = prof): BrainItem[] => clean(v) ? [{ label, text: clean(v), source }] : []
  const each = (label: string, a: unknown): BrainItem[] => list(a).map(text => ({ label, text, source: prof }))
  const site = httpsUrl(p?.website)
  return [
    { id: 'company', title: 'Company & offer', edit: 'profile', items: merge(
      field('Company', p?.business_name), field('What you sell', p?.sells),
      site ? [{ label: 'Website', text: site, source: { kind: 'site', url: site } }] : [],
      siteItems(b?.research, ['offer']).map(i => ({ ...i, label: 'Offer' })),
      field('Positioning', m?.positioning, mem)) },
    { id: 'customer', title: 'Ideal customer', edit: 'profile', items: merge(
      field('Summary', b?.summary), each('Industry', b?.industries), each('Company size', b?.sizes), each('Where', b?.where),
      siteItems(b?.research, ['industry']).map(i => ({ ...i, label: 'Industry' })), siteItems(b?.research, ['size']).map(i => ({ ...i, label: 'Company size' })),
      siteItems(b?.research, ['location']).map(i => ({ ...i, label: 'Where' })),
      each('Not a fit', b?.exclude), siteItems(b?.research, ['disqualifier']).map(i => ({ ...i, label: 'Not a fit' })),
      field('In your words', m?.icp, mem), list(m?.exclusions).map(text => ({ label: 'Skip', text, source: mem }))) },
    { id: 'roles', title: 'Buyer roles', edit: 'profile', items: merge(each('Role', b?.who), siteItems(b?.research, ['persona']).map(i => ({ ...i, label: 'Role' }))) },
    { id: 'signals', title: 'Buying signals', edit: 'profile', items: merge(each('Signal', b?.signals), siteItems(b?.research, ['pain']).map(i => ({ ...i, label: 'Need' }))) },
    { id: 'competitors', title: 'Competitors', edit: 'competitors', items: list(competitors).map(text => ({ text, source: { kind: 'competitors' } })) },
    { id: 'objections', title: 'Objections & answers', edit: 'memory', items: (Array.isArray(m?.objections) ? m!.objections : [])
      .filter(o => clean(o?.q)).map(o => ({ label: clean(o.q), text: clean(o.a) || '(no answer saved yet)', source: mem })) },
    { id: 'voice', title: 'Voice', edit: 'memory', items: field('Tone', m?.tone, mem) },
  ]
}

export interface BrainPlay { label: string; query: string }
// Up to 5 one-click plays built only from what is saved, and only with signals dazl's search can actually find:
// a buyer role (or industry) in the first place named with a saved signal, companies hiring the role a saved hiring
// signal names (a job-posting signal, lib/scan/targeting.ts), and people looking for an alternative to a saved competitor (complaint/alternatives posts,
// lib/signals/competitor-reddit.ts). Nothing is suggested when the profile has nothing to build it from.
export function businessPlays(p: BrainProfile | null, competitors: string[] | null): BrainPlay[] {
  const b = p?.buyer ?? null
  const who = list(b?.who), ind = list(b?.industries), where = list(b?.where)[0] ?? '', sig = list(b?.signals)
  const place = where ? ` in ${where}` : ''
  const out: BrainPlay[] = []
  const add = (label: string, query: string) => { const q = query.replace(/\s+/g, ' ').trim().slice(0, 300); if (q && !out.some(o => o.query === q) && out.length < 5) out.push({ label, query: q }) }
  const buyer = who[0] || (ind[0] ? `${ind[0]} companies` : '')
  if (buyer && sig[0]) add(`${buyer}${place}`, `${buyer}${place} - ${sig[0]}`)
  // a hiring play only from a saved signal that IS a hiring signal ("hiring SDRs"): the buyer is the decision-maker, not the
  // person being hired, so a buyer role is never turned into "companies hiring <role>"
  for (const h of sig.map(x => /\bhir(?:e|es|ing)\s+(?:a |an |their first |new )?(.{2,80})$/i.exec(x)?.[1]?.trim()).filter((x): x is string => !!x).slice(0, 2))
    add(`${buyer ? `${buyer} at companies` : 'Companies'} hiring ${h}${place}`, `${buyer ? `${buyer} at companies` : 'Companies'}${place} hiring ${h}`)
  for (const c of list(competitors).slice(0, 2)) add(`Looking for an alternative to ${c}`, `${buyer || 'Companies'}${place} looking for an alternative to ${c}`)
  // a second signal play, unless that signal already became the hiring play above (the same search in other words)
  if (buyer && sig[1] && !/\bhir(?:e|es|ing)\b/i.test(sig[1])) add(`${buyer}${place}: ${sig[1]}`, `${buyer}${place} - ${sig[1]}`)
  return out
}
