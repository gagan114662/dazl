// Free, read-only reading of a saved lead's own pages for outbound-sales-prospecting context. No model, no spend.
// It sorts literal sentences into separate kinds and keeps each one as a quote taken verbatim from the page:
//   team_task        - the posting describes work its own team or role does (a duty cue plus a topic term)
//   named_stack      - the page names a sales tool in a sentence about the company's own work or setup
//   stated_problem   - the company says it is evaluating, replacing or struggling with sales tooling or prospecting
//   candidate_requirement - a skill asked of a job applicant. Shown apart; it is not evidence the team has a need
// Excluded from evidence and only counted: vendor_pitch (the company is selling in this topic, so it may be a
// competitor, not a buyer) and advice (guide or tips text). A sentence with a topic term but no clear subject is
// counted as unclear, never shown as evidence. There is no score, no ranking and no fit verdict: finding nothing
// is a real result. The topic list is fixed and named below, so the reader sees exactly what was looked for.
export const TOPIC = 'outbound sales prospecting'
export const TASK_TERMS = ['outbound', 'cold call', 'cold calling', 'cold email', 'cold outreach', 'prospecting', 'prospect list', 'lead generation', 'lead gen', 'pipeline generation', 'sales development', 'appointment setting']
export const STACK_NAMES = ['salesforce', 'hubspot', 'salesloft', 'outreach.io', 'apollo.io', 'zoominfo', 'gong.io', 'sales navigator', 'lusha', 'seamless.ai', 'clay.com', 'instantly.ai', 'lemlist', '6sense']
export type SignalKind = 'team_task' | 'named_stack' | 'stated_problem' | 'candidate_requirement'
export interface PageSignal { kind: SignalKind; term: string; quote: string }
export interface PageReading {
  chars_read: number
  sentences: number
  signals: PageSignal[]
  vendor_pitch: number
  advice: number
  unclear: number
}

const REQUIREMENT = /\b(experience (with|in|using|of)|proficien\w*|familiar\w*|knowledge of|\d+\+? years?|you have|you've|must have|requirements?|qualifications?|ideal candidate|nice to have|preferred|skills?:?|track record|comfortable (with|using))\b/i
const PITCH = /\b(our (platform|software|product|solution|tool|app)s?|we help|helps? (sales|teams|companies|you|reps)|book a demo|request a demo|free trial|start (your )?free|get started|pricing|trusted by|customers? (use|love))\b/i
const ADVICE = /\b(tips?|how to|best practices?|you should|guide to|ways to|steps to|why you)\b/i
const DUTY = /\b(you will|you'll|you are responsible|responsible for|responsibilities|your role|own (the|our|and)|building (the|our|out)|build (the|our|out)|run (the|our)|running (the|our)|drive|generate|source|manage|execut\w+|conduct\w*|perform\w*|handl\w+|identify\w*|lead (the|our)|our (sales|sdr|bdr|revenue|growth) team|we (run|use|are building|are scaling|are hiring))\b/i
const PROBLEM = /\b(evaluat\w+|replac\w+|migrat\w+|switch\w*|struggl\w+|looking for (a|an|new)|researching|vendor selection|shortlist\w*|rfp|need (a|an|better))\b/i

const has = (hay: string, term: string) => new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`, 'i').test(hay)

// Windows over the ORIGINAL text, one per topic hit, so every quote is a verbatim slice of the page. Pages often
// arrive with headings glued to the next line and few full stops, so the window is bounded by the nearest sentence
// mark within 170 characters on each side, else it is cut at a word boundary.
const MAX_SIDE = 170
export function hitWindows(text: string, terms: string[]): { term: string; quote: string }[] {
  const out: { term: string; quote: string; a: number; b: number }[] = []
  for (const term of terms) {
    const re = new RegExp(`(^|[^a-z0-9])(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?=$|[^a-z0-9])`, 'gi')
    for (const m of text.matchAll(re)) {
      const i = (m.index ?? 0) + m[1].length, j = i + term.length
      let a = Math.max(0, i - MAX_SIDE), b = Math.min(text.length, j + MAX_SIDE)
      const before = text.slice(a, i), cut = Math.max(before.lastIndexOf('. '), before.lastIndexOf('! '), before.lastIndexOf('? '), before.lastIndexOf('\n'))
      if (cut >= 0) a = a + cut + 2
      else if (a > 0) { const sp = text.indexOf(' ', a); if (sp >= 0 && sp < i) a = sp + 1 }
      const after = text.slice(j, b), ends = [after.search(/[.!?](\s|$)/), after.indexOf('\n')].filter(x => x >= 0)
      if (ends.length) b = j + Math.min(...ends) + 1
      else if (b < text.length) { const sp = text.lastIndexOf(' ', b); if (sp > j) b = sp }
      const quote = text.slice(a, b).trim()
      if (quote.length >= 12 && !out.some(o => a < o.b && b > o.a)) out.push({ term, quote, a, b })
    }
  }
  return out.sort((x, y) => x.a - y.a).map(({ term, quote }) => ({ term, quote }))
}

export function readPage(text: string, role: 'posting' | 'company_home', cap = 60_000): PageReading {
  const body = text.slice(0, cap)
  const wins = hitWindows(body, [...TASK_TERMS, ...STACK_NAMES])
  const r: PageReading = { chars_read: body.length, sentences: wins.length, signals: [], vendor_pitch: 0, advice: 0, unclear: 0 }
  for (const { term, quote } of wins) {
    const isStack = STACK_NAMES.includes(term)
    const problemish = PROBLEM.test(quote) && (!isStack || true)
    if (PITCH.test(quote)) { r.vendor_pitch++; continue }
    if (ADVICE.test(quote)) { r.advice++; continue }
    if (REQUIREMENT.test(quote)) { if (role === 'posting') r.signals.push({ kind: 'candidate_requirement', term, quote }); else r.unclear++; continue }
    if (problemish && /\b(we|our)\b/i.test(quote)) { r.signals.push({ kind: 'stated_problem', term, quote }); continue }
    // A company home page describes the company's offer, not its own team's work: only a stated problem counts there.
    if (role === 'posting' && DUTY.test(quote)) { r.signals.push({ kind: isStack ? 'named_stack' : 'team_task', term, quote }); continue }
    r.unclear++
  }
  r.signals = r.signals.slice(0, 12)
  return r
}

import type Database from 'better-sqlite3'
import { fetchPageDetailed, isFail, type FetchFail, type Page } from './fetch-page.ts'
export interface LeadPageReading { url: string; role: 'posting' | 'company_home'; status: 'read' | 'failed' | 'not_used'; why?: string; reading?: PageReading }
export interface LeadSignals { lead_id: string; company: string; topic: string; looked_for: { task_terms: string[]; stack_names: string[] }; pages: LeadPageReading[]; model_call: false }

// Reads the lead's own saved posting page, and its home page only when the lead already has a confirmed site.
// A posting page is used only if it names the company. Public pages only; no model, no spend, nothing stored.
export async function leadSignals(db: Database.Database, userId: string, leadId: string, fetchPage: (u: string) => Promise<Page | FetchFail> = fetchPageDetailed): Promise<LeadSignals | null> {
  const lead = db.prepare('SELECT l.id, l.company, l.source_url, l.company_domain FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.id = ? AND j.user_id = ?').get(leadId, userId) as { id: string; company: string; source_url: string; company_domain: string | null } | undefined
  if (!lead) return null
  const targets: { url: string; role: 'posting' | 'company_home' }[] = []
  if (/^https:\/\//.test(lead.source_url)) targets.push({ url: lead.source_url, role: 'posting' })
  if (lead.company_domain && /^[a-z0-9.-]+$/i.test(lead.company_domain)) targets.push({ url: `https://${lead.company_domain}/`, role: 'company_home' })
  const nameOk = (t: string) => { const c = lead.company.toLowerCase().replace(/\s+/g, ' ').trim(); return c.length >= 2 && t.toLowerCase().replace(/\s+/g, ' ').includes(c) }
  const pages = await Promise.all(targets.map(async (t): Promise<LeadPageReading> => {
    const r = await fetchPage(t.url).catch(() => ({ fail: 'error' }) as FetchFail)
    if (!r || isFail(r)) return { url: t.url, role: t.role, status: 'failed', why: (r as FetchFail | null)?.fail ?? 'error' }
    if (t.role === 'posting' && !nameOk(r.text)) return { url: t.url, role: t.role, status: 'not_used', why: 'the posting page does not name the company' }
    return { url: t.url, role: t.role, status: 'read', reading: readPage(r.text, t.role) }
  }))
  return { lead_id: lead.id, company: lead.company, topic: TOPIC, looked_for: { task_terms: TASK_TERMS, stack_names: STACK_NAMES }, pages, model_call: false }
}
