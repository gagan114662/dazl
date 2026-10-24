// Free, read-only reading of a saved lead's own pages. No model, no spend.
// It finds passages that contain topic words (outbound sales prospecting terms or named sales tools) and copies each one
// verbatim. It does NOT decide who a passage is about, whether it is negated, or whether it shows a need: a passage can
// be a duty, a requirement for an applicant, a vendor's own pitch, an advice line, a customer's story or a negation, and
// regexes cannot tell these apart reliably. So every passage is shown for a person to read, with the literal phrases
// found inside it listed as plain facts (e.g. the words "you will", "experience with", "not"). Nothing is counted as
// evidence, scored, ranked or labelled as the company's own task, need or problem. Finding nothing is a real result.
export const TOPIC = 'outbound sales prospecting'
// The word list is written for ONE kind of seller: someone selling outbound sales prospecting tools (the current test offer).
// It is not adapted to the account's offer and says nothing about any other kind of seller.
export const APPLIES_TO = 'a seller of outbound sales prospecting tools'
export const TASK_TERMS = ['outbound', 'cold call', 'cold calling', 'cold email', 'cold outreach', 'prospecting', 'prospect list', 'lead generation', 'lead gen', 'pipeline generation', 'sales development', 'appointment setting']
export const STACK_NAMES = ['salesforce', 'hubspot', 'salesloft', 'outreach.io', 'apollo.io', 'gong.io', 'zoominfo', 'sales navigator', 'lusha', 'seamless.ai', 'clay.com', 'instantly.ai', 'lemlist', '6sense']
export interface PhraseFlags { duty: string | null; requirement: string | null; self_description: string | null; evaluation: string | null; negation: string | null }
export interface Passage { terms: string[]; quote: string; phrases: PhraseFlags }
export interface PageReading { chars_read: number; passages: Passage[]; passages_total: number }

const PATTERNS: Record<keyof PhraseFlags, RegExp> = {
  duty: /\b(you will|you'll|responsible for|responsibilities|your role|you own|own the|we are hiring|our team)\b/i,
  requirement: /\b(experience (with|in|using|of)|proficien\w*|familiar\w*|knowledge of|\d+\+? years?|you have|you've|must have|requirements?|qualifications?|ideal candidate|nice to have|preferred)\b/i,
  self_description: /\b(our (platform|software|product|solution|tool|app)s?|we help|helps? (sales|teams|companies|you|reps)|book a demo|free trial|pricing|trusted by|our customers)\b/i,
  evaluation: /\b(evaluat\w+|replac\w+|migrat\w+|switch\w*|struggl\w+|looking for (a|an|new)|researching|shortlist\w*|rfp)\b/i,
  negation: /\b(not|no|never|without|neither|nor|none|n't|cannot|won't|don't|doesn't|isn't|aren't)\b|n't\b/i,
}
export const PHRASE_LABEL: Record<keyof PhraseFlags, string> = { duty: 'a duty-style phrase', requirement: 'a requirement-style phrase', self_description: 'a phrase about the company\'s own product', evaluation: 'an evaluation-style word', negation: 'a negation word' }
const flags = (q: string): PhraseFlags => {
  const f = {} as PhraseFlags
  for (const k of Object.keys(PATTERNS) as (keyof PhraseFlags)[]) f[k] = PATTERNS[k].exec(q)?.[0] ?? null
  return f
}
const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// One window per cluster of hits, cut from the ORIGINAL text so each quote is a verbatim slice of the page. Pages often
// arrive with headings glued to the next line and few full stops, so a window is bounded by the nearest sentence mark or
// line break within 170 characters of the hit, else cut at a word boundary. Every term found inside a window is listed.
const MAX_SIDE = 170
export function hitWindows(text: string, terms: string[]): { terms: string[]; quote: string }[] {
  const raw: { term: string; a: number; b: number }[] = []
  for (const term of terms) {
    const re = new RegExp(`(^|[^a-z0-9])(${esc(term)})(?=$|[^a-z0-9])`, 'gi')
    for (const m of text.matchAll(re)) {
      const i = (m.index ?? 0) + m[1].length, j = i + term.length
      let a = Math.max(0, i - MAX_SIDE), b = Math.min(text.length, j + MAX_SIDE)
      const before = text.slice(a, i)
      const stop = Math.max(before.lastIndexOf('. ') >= 0 ? before.lastIndexOf('. ') + 2 : -1, before.lastIndexOf('! ') >= 0 ? before.lastIndexOf('! ') + 2 : -1, before.lastIndexOf('? ') >= 0 ? before.lastIndexOf('? ') + 2 : -1, before.lastIndexOf('\n') >= 0 ? before.lastIndexOf('\n') + 1 : -1)
      if (stop >= 0) a += stop
      else if (a > 0) { const sp = text.indexOf(' ', a); if (sp >= 0 && sp < i) a = sp + 1 }
      const after = text.slice(j, b), mk = after.search(/[.!?](\s|$)/), nl = after.indexOf('\n')
      const ends = [mk >= 0 ? mk + 1 : -1, nl].filter(x => x >= 0)
      if (ends.length) b = j + Math.min(...ends)
      else if (b < text.length) { const sp = text.lastIndexOf(' ', b); if (sp > j) b = sp }
      raw.push({ term, a, b })
    }
  }
  raw.sort((x, y) => x.a - y.a || x.b - y.b)
  const merged: { terms: Set<string>; a: number; b: number }[] = []
  for (const w of raw) {
    const last = merged[merged.length - 1]
    if (last && w.a < last.b) { last.terms.add(w.term); last.b = Math.max(last.b, w.b) } else merged.push({ terms: new Set([w.term]), a: w.a, b: w.b })
  }
  return merged.map(m => ({ terms: [...m.terms], quote: text.slice(m.a, m.b).trim() })).filter(w => w.quote.length >= 12)
}

export function readPage(text: string, cap = 60_000, show = 12): PageReading {
  const body = text.slice(0, cap)
  const wins = hitWindows(body, [...TASK_TERMS, ...STACK_NAMES])
  const passages = wins.slice(0, show).map(w => ({ terms: w.terms, quote: w.quote.length > 420 ? w.quote.slice(0, 420) : w.quote, phrases: flags(w.quote) }))
  return { chars_read: body.length, passages, passages_total: wins.length }
}

import type Database from 'better-sqlite3'
import { fetchPageDetailed, isFail, type FetchFail, type Page } from './fetch-page.ts'
export interface LeadPageReading { url: string; role: 'posting' | 'company_home'; status: 'read' | 'failed' | 'not_used'; why?: string; reading?: PageReading }
export interface LeadSignals { lead_id: string; company: string; topic: string; applies_to: string; looked_for: { task_terms: string[]; stack_names: string[] }; pages: LeadPageReading[]; model_call: false }

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
    return { url: t.url, role: t.role, status: 'read', reading: readPage(r.text) }
  }))
  return { lead_id: lead.id, company: lead.company, topic: TOPIC, applies_to: APPLIES_TO, looked_for: { task_terms: TASK_TERMS, stack_names: STACK_NAMES }, pages, model_call: false }
}
