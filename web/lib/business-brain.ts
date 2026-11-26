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
import { compileTargeting, planConditions, conditionRoles, readsAsDenial } from './scan/targeting.ts'

export interface BrainProfile { business_name?: string | null; sells?: string | null; website?: string | null; buyer?: Icp | null }
export interface BrainMemory { icp?: string; positioning?: string; tone?: string; exclusions?: string[]; objections?: { q: string; a: string }[] }
export type Source = { kind: 'site'; url: string } | { kind: 'profile' } | { kind: 'memory' } | { kind: 'competitors' }
export interface BrainItem { label?: string; text: string; source: Source }
export interface BrainSection { id: 'company' | 'customer' | 'roles' | 'signals' | 'competitors' | 'objections' | 'voice'; title: string; items: BrainItem[]; edit: 'profile' | 'memory' | 'competitors'; reads: ('profile' | 'memory' | 'competitors')[] }

const clean = (s: unknown) => typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : ''
const list = (a: unknown) => Array.isArray(a) ? a.map(clean).filter(Boolean) : []
const httpsUrl = (u: unknown) => typeof u === 'string' && /^https:\/\/[^\s]{4,500}$/.test(u) ? u : null

// Only a source-backed research item with a page earns "from your site"; hypotheses and rejected items do not.
const host = (u: unknown) => { try { return typeof u === 'string' && u ? new URL(/^https?:\/\//i.test(u) ? u : 'https://' + u).hostname.replace(/^www\./, '').toLowerCase() : null } catch { return null } }
// the research must be about the website saved NOW (after a website change, the old site's items are not "your site"),
// and each item needs its page AND the quote found there (the same bar as the research review, app/app/research-review.tsx)
function siteItems(research: Icp['research'], kinds: ResearchedHyp['k'][], website: unknown): BrainItem[] {
  const hyps = Array.isArray(research?.hyps) ? research!.hyps : []
  const site = host(website)
  if (!site || host(research?.site) !== site) return []
  return hyps.filter(h => kinds.includes(h.k) && (h.s === 'sourced' || h.s === 'reviewed') && httpsUrl(h.u) && host(h.u) === site && clean(h.q) && clean(h.t))
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
    { id: 'company', reads: ['profile', 'memory'], title: 'Company & offer', edit: 'profile', items: merge(
      field('Company', p?.business_name), field('What you sell', p?.sells),
      site ? [{ label: 'Website', text: site, source: prof }] : [],   // the address the user saved, not a page dazl read
      siteItems(b?.research, ['offer'], p?.website).map(i => ({ ...i, label: 'Offer' })),
      field('Positioning', m?.positioning, mem)) },
    { id: 'customer', reads: ['profile', 'memory'], title: 'Ideal customer', edit: 'profile', items: merge(
      field('Summary', b?.summary), each('Industry', b?.industries), each('Company size', b?.sizes), each('Where', b?.where),
      siteItems(b?.research, ['industry'], p?.website).map(i => ({ ...i, label: 'Industry' })), siteItems(b?.research, ['size'], p?.website).map(i => ({ ...i, label: 'Company size' })),
      siteItems(b?.research, ['location'], p?.website).map(i => ({ ...i, label: 'Where' })),
      each('Not a fit', b?.exclude), siteItems(b?.research, ['disqualifier'], p?.website).map(i => ({ ...i, label: 'Not a fit' })),
      field('In your words', m?.icp, mem), list(m?.exclusions).map(text => ({ label: 'Skip', text, source: mem }))) },
    { id: 'roles', reads: ['profile'], title: 'Buyer roles', edit: 'profile', items: merge(each('Role', b?.who), siteItems(b?.research, ['persona'], p?.website).map(i => ({ ...i, label: 'Role' }))) },
    { id: 'signals', reads: ['profile'], title: 'Buying signals', edit: 'profile', items: merge(each('Signal', b?.signals), siteItems(b?.research, ['pain'], p?.website).map(i => ({ ...i, label: 'Need' }))) },
    { id: 'competitors', reads: ['competitors'], title: 'Competitors', edit: 'competitors', items: list(competitors).map(text => ({ text, source: { kind: 'competitors' } })) },
    { id: 'objections', reads: ['memory'], title: 'Objections & answers', edit: 'memory', items: (Array.isArray(m?.objections) ? m!.objections : [])
      .filter(o => clean(o?.q)).map(o => ({ label: clean(o.q), text: clean(o.a) || '(no answer saved yet)', source: mem })) },
    { id: 'voice', reads: ['memory'], title: 'Voice', edit: 'memory', items: field('Tone', m?.tone, mem) },
  ]
}

// lib/signals/competitor-reddit.ts MAX_COMPETITORS (not imported: that module is server-side; test/business-brain-1043.test.ts pins them equal)
export const COMPLAINT_COMPETITORS = 5
export interface BrainPlay { label: string; query: string }
// Up to 5 one-click plays built only from what is saved, and only with signals dazl's search can actually find:
// a buyer role (or industry) in the first place named with a saved signal, companies hiring the role a saved hiring
// signal names (a job-posting signal, lib/scan/targeting.ts), and people looking for an alternative to a saved competitor (a plain web-search sentence; the complaint/alternatives
// connector, lib/signals/competitor-reddit.ts, adds posts only when it is enabled for the workspace). Nothing is suggested when the profile has nothing to build it from.
export function businessPlays(p: BrainProfile | null, competitors: string[] | null): BrainPlay[] {
  const b = p?.buyer ?? null
  const who = list(b?.who), ind = list(b?.industries), where = list(b?.where)[0] ?? '', sig = list(b?.signals)
  const place = where ? ` in ${where}` : ''
  const out: BrainPlay[] = []
  const add = (label: string, query: string) => { const q = query.replace(/\s+/g, ' ').trim().slice(0, 300); if (q && !out.some(o => o.query === q) && out.length < 5) out.push({ label, query: q }) }
  // Every play is judged on the signal's own compiled plan (lib/scan/targeting.ts), never joined with the buyer text (a buyer
  // such as "Hiring manager" would supply a condition itself). #1163: the plan decides, so there is no list of negating wordings here.
  // - a HIRING play: every condition in the plan is a hiring condition, and at least one POSITIVE one names a role. A denial is
  //   not(...) in the plan ("stopped hiring SDRs", "hiring SDRs on hold", "instead of hiring recruiters"), so it makes none; a
  //   lifted freeze followed by real hiring ("hiring freeze lifted, now hiring SDRs") holds two positive hiring conditions, the
  //   second with a role, and makes one. What follows the hiring word in that condition must be a role and nothing else by shape
  //   (roleShape), and it must be the last thing the signal says.
  // - a PLAIN play: any other signal with a positive condition; a hiring condition backs one only as "hiring" with no role
  //   ("Expanding team, hiring"). A mixed signal ("raised a Series A, hiring SDRs") stays a plain play.
  // A free-form signal the compiler cannot enforce ("attended a trade show", or a signal in a language it does not read) makes none.
  // #1722: an industry that already reads plural keeps its own wording (trailing 's' without 'ss' - the general
  // rule, no word list), and only a role buyer gets the " at companies" qualifier: an industry names companies already.
  const fromRole = !!who[0]
  const ind0 = (ind[0] ?? '').toLowerCase()
  const buyer = who[0] || (ind[0] ? (ind0.endsWith('s') && !ind0.endsWith('ss') ? ind[0] : `${ind0} companies`) : '')
  const HIRING_NOUN = /^(?:slowdown|moratorium|ban|cap|cutbacks?|pullback|restrictions?|drought|embargo|lull|standstill|plans?|budget|freeze|pause)$/i
  const conds = (x: string) => planConditions(compileTargeting(x).root)
  // A word that cannot be part of a role: a function or particle word, or a quantifier or indefinite pronoun that turns the phrase
  // into a denial ("hiring nobody", "hiring nil SDRs", "hiring minimal staff"), plus the two predicative adjectives a hiring phrase
  // uses to deny itself ("hiring SDRs impossible"). A word ending in -ed or -ly is a verb or an adverb, not a role word.
  const NOT_A_ROLE = /^(?:is|are|was|were|be|been|has|had|off|out|down|up|over|anymore|yet|not|never|no|none|nobody|nothing|any|anyone|anybody|neither|nor|zero|nil|zilch|minimal|impossible|unlikely|frozen|froze|fewer|less|few)$/i
  const roleShape = (tail: string): boolean => {
    const words = tail.trim().split(/\s+/).filter(Boolean)
    if (!words.length || words.length > 5 || /[^A-Za-z\s&/-]/.test(tail)) return false
    if (words.some(w => NOT_A_ROLE.test(w) || /ed$/i.test(w) || /ly$/i.test(w))) return false
    return !HIRING_NOUN.test(words[words.length - 1])
  }
  // Every role the plan gives this signal's positive hiring conditions, in plain words ("SDR or salesperson"), never only the first.
  const hiringRoles = (x: string): string[] => {
    const plan = conds(x)
    if (!plan.length || plan.some(p => p.cond.kind !== 'hiring')) return []
    const out: string[] = []
    for (const p of plan) {
      if (p.negated) continue
      const at = x.lastIndexOf(p.cond.text), tail = p.cond.text.replace(/^\s*hir(?:e|es|ing|ed)\b\s*/i, '')
      if (at < 0 || !roleShape(tail)) continue
      // what follows the condition may only be more roles joined by and/or: "hiring SDRs? Nope" is not a hire
      const after = x.trim().slice(at + p.cond.text.length)
      if (!/^[\s.,;:!?]*$/.test(after) && !/^[\s.,;:]*\b(?:and|or)\b\s+[A-Za-z][A-Za-z\s&/-]*$/.test(after)) continue
      const all = conditionRoles(p.cond).join(' or ')
      const role = all.length > 80 ? all.slice(0, 80).replace(/\s+\S*$/, '') : all   // never cut a role mid-word
      if (role && role.length >= 2 && !/^(?:the|this|that|our|its|their|a|an|of)\b$/i.test(role) && !/^of\s/i.test(role)) out.push(role)
    }
    return out
  }
  // a signal that denies anything makes no plain play either: the denial is the user saying what they do NOT want, and a search for
  // the whole wording searches for it. The plan says so, so no word list is needed.
  const plainOk = (x: string) => {
    const plan = conds(x)
    return !hiringRoles(x).length && !readsAsDenial(x) && !plan.some(c => c.negated) && plan.some(c => c.cond.kind !== 'hiring' || !(c.cond.role ?? '').trim())
  }
  const firstPlain = sig.find(plainOk)
  if (buyer && firstPlain) add(`${buyer}${place}`, `${buyer}${place} - ${firstPlain}`)
  // a hiring play only from a saved signal that IS a hiring signal ("hiring SDRs"): the buyer is the decision-maker, not the
  // person being hired, so a buyer role is never turned into "companies hiring <role>"
  for (const h of sig.flatMap(hiringRoles).slice(0, 2))
    add(`${buyer ? `${buyer}${fromRole ? ' at companies' : ''}` : 'Companies'} hiring ${h}${place}`, `${buyer ? `${buyer}${fromRole ? ' at companies' : ''}` : 'Companies'}${place} hiring ${h}`)
  // one play naming every competitor the scan's complaint collector reads (it reads the saved list up to its MAX_COMPETITORS, 5,
  // lib/signals/competitor-reddit.ts; pinned by test), so the play never leaves out a competitor whose complaints it surfaces
  const comps = list(competitors).slice(0, COMPLAINT_COMPETITORS)
  const named = comps.length > 1 ? `${comps.slice(0, -1).join(', ')} or ${comps[comps.length - 1]}` : comps[0]
  const compQuery = `${buyer || 'Companies'}${place} looking for an alternative to ${named}`
  // a query that would be cut (add() keeps 300 characters) would drop a name: no competitor play then, never a partial one
  if (comps.length && compQuery.replace(/\s+/g, ' ').trim().length <= 300) add(`Looking for an alternative to ${named}`, compQuery)
  // a second plain-signal play (hiring signals are already the hiring plays above)
  const secondPlain = sig.filter(plainOk)[1]
  if (buyer && secondPlain) add(`${buyer}${place}: ${secondPlain}`, `${buyer}${place} - ${secondPlain}`)
  return out
}

// The profile editor's save (#1043): the body for POST /api/settings/profile. The stored buyer's other fields (research,
// window, country, language, lookalike) are kept as they are; the website is always sent (blank clears it). A profile with
// no stored buyer and no "who you sell to" saves the company fields alone - the route refuses a buyer without a summary,
// so buyer details without one are an error the user can fix, never a silent drop.
export interface ProfileForm { business_name: string; sells: string; website: string; summary: string; who: string[]; industries: string[]; sizes: string[]; where: string[]; signals: string[]; exclude: string[] }
export function profilePayload(stored: BrainProfile | null, f: ProfileForm): { body: Record<string, unknown> } | { error: string } {
  const body: Record<string, unknown> = { business_name: f.business_name.trim(), sells: f.sells.trim(), website: f.website.trim() }
  const cleanList = (a: string[]) => a.map(x => x.trim()).filter(Boolean)
  const lists = { who: cleanList(f.who), industries: cleanList(f.industries), sizes: cleanList(f.sizes), where: cleanList(f.where), signals: cleanList(f.signals), exclude: cleanList(f.exclude) }
  const summary = f.summary.trim()
  const anyList = Object.values(lists).some(a => a.length > 0)
  if (!summary) {
    if (anyList || stored?.buyer) return { error: 'Add who you sell to (a short description) before saving the buyer details.' }
    return { body }
  }
  const base: Icp = stored?.buyer ?? { summary: '', who: [], industries: [], sizes: [], where: [], signals: [], exclude: [] }
  body.buyer = { ...base, summary, ...lists }
  return { body }
}
