// The Home journey: which leads a play may show as opportunities, and the one next action for the account's real state.
// Pure and read-only. It never loosens a gate: a lead enters the preview only when every existing check already passed
// (identity confirmed or not in doubt, a verified dated source, inside the requested window, not held, rejected or in
// review). Everything else is counted separately as "needs review / research" and never adds to the opportunity count.
import { evidenceStateOf } from './outreach/evidence-state.ts'
import { domainReviewFor } from './outreach/domain-review.ts'
import { publishedEmail } from './outreach/published-email.ts'
import { scanOutcome, type ScanOutcomeKind } from './scan/scan-outcome.ts'
import type { CardLead } from './scan/opportunity.ts'
import { heldState, type ResearchCause } from './lead-state.ts'

export type PreviewLead = CardLead & { id: string; seen_before?: number | boolean | null }

// Why a lead is not an opportunity (first failing check), or null when it is one.
export function heldReason(l: PreviewLead): string | null {
  if (l.quarantined_at) return 'rejected'
  if (l.review_reason) return 'needs your review'
  if (evidenceStateOf({ evidence_excerpt: l.evidence_excerpt, confidence: l.confidence ?? null, human_confirmed_at: l.human_confirmed_at ?? null }) === 'unverified') return 'source not verified'
  if (l.window_held) return 'outside your time window or undated'
  if (l.currentness_held) return 'event timing unknown'
  if (!l.event_date || l.date_status !== 'verified') return 'no verified date'
  if (domainReviewFor({ id: l.id, contact: l.contact }, l.enrichments ?? []).state === 'required') return 'company website not confirmed'
  if (l.fit === 0 && l.intent === null) return 'not a fit'
  return null
}

export interface PreviewSplit { opportunities: (PreviewLead & { contactReady: boolean })[]; held: { lead: PreviewLead; reason: string }[]; review: PreviewLead[]; research: { lead: PreviewLead; cause: ResearchCause }[]; rejected: PreviewLead[] }
export function previewSplit(leads: PreviewLead[]): PreviewSplit {
  const out: PreviewSplit = { opportunities: [], held: [], review: [], research: [], rejected: [] }
  for (const l of leads) {
    const why = heldReason(l)
    if (why) {
      out.held.push({ lead: l, reason: why })
      const h = heldState(l)
      if (h?.state === 'review') out.review.push(l)
      else if (h?.state === 'rejected') out.rejected.push(l)
      else out.research.push({ lead: l, cause: h?.cause ?? 'unsupported' })
    }
    else out.opportunities.push({ ...l, contactReady: !!publishedEmail(l) })
  }
  return out
}

export interface JourneyJob { id: string; status: string; error: string | null; query: string | null; csv_domain: string | null; created_at: number; candidates: number | null; verified: number | null; needs_review: number | null; dropped: number | null; lead_count: number; test_only: boolean; empty_reason?: string | null }
export interface JourneyInput {
  profile: { website?: string; sells?: string; buyer?: unknown } | null   // null: could not load
  jobs: JourneyJob[] | null                                                // null: could not load
  leads: PreviewLead[] | null                                              // the current play's leads; null: not loaded / failed
  drafts: { drafts: number; approved: number } | null                      // the SAME campaign's unsent emails; null: unknown
}
export type Stage = 'unknown' | 'no_profile' | 'no_play' | 'running' | 'failed' | 'zero' | 'all_held' | 'research_only' | 'useful'
export interface Journey { stage: Stage; play: JourneyJob | null; split: PreviewSplit | null; action: { label: string; href: string } | null; line: string }

const own = (j: JourneyJob) => !!j.query && !j.csv_domain && !j.test_only
const ACTIVE = new Set(['pending', 'running', 'enriching'])

export function currentPlay(jobs: JourneyJob[]): JourneyJob | null {
  const mine = jobs.filter(own).sort((a, b) => b.created_at - a.created_at)
  return mine.find(j => ACTIVE.has(j.status)) ?? mine[0] ?? null
}

export function journey(i: JourneyInput): Journey {
  const base = { play: null, split: null }
  if (!i.profile || !i.jobs) return { ...base, stage: 'unknown', action: null, line: 'Could not load your account. Reload to retry.' }
  if (!i.profile.sells && !i.profile.website && !i.profile.buyer) return { ...base, stage: 'no_profile', action: { label: 'Tell dazl about your business', href: '/app?setup=site' }, line: 'Start with your website.' }
  const play = currentPlay(i.jobs)
  if (!play) return { ...base, stage: 'no_play', action: { label: 'Find your first leads', href: '/app/leads' }, line: 'Describe who you want to reach.' }
  const leadsHref = `/app/leads?job_id=${play.id}`
  if (ACTIVE.has(play.status)) return { ...base, play, stage: 'running', action: { label: 'See progress', href: leadsHref }, line: play.status === 'pending' ? 'Your play is queued.' : play.status === 'enriching' ? 'Your play is finishing.' : 'Your play is searching now.' }
  const o = scanOutcome({ ...play, empty_reason: play.empty_reason ?? null })
  const kind: ScanOutcomeKind = o.kind
  if (kind === 'running' || kind === 'enriching') return { ...base, play, stage: 'running', action: { label: 'See progress', href: leadsHref }, line: 'Your play is finishing.' }
  if (kind === 'failed' || kind === 'stopped') return { ...base, play, stage: 'failed', action: o.next ? { label: o.next.text, href: o.next.href } : null, line: o.label }
  if (kind === 'none_extracted') return { ...base, play, stage: 'zero', action: { label: 'Try a broader play', href: '/app/leads' }, line: 'This play found 0 companies.' }
  // From here the scan saved leads (or recorded drops). The preview decides; a lead list that did not load is not a zero.
  if (!i.leads) return { ...base, play, stage: 'unknown', action: { label: 'Open its leads', href: leadsHref }, line: 'Could not load this play\'s leads.' }
  const split = previewSplit(i.leads)
  if (split.opportunities.length === 0) {
    if (split.held.length === 0) return { ...base, play, split, stage: 'zero', action: kind === 'all_dropped' ? { label: 'See why they were dropped', href: leadsHref } : { label: 'Try a broader play', href: '/app/leads' }, line: 'This play has 0 opportunities.' }
    const r = split.review.length, plural = (n: number) => n === 1 ? '' : 's'
    // Only leads a person's check can change are "review". Research-only leads (no usable date, outside the window,
    // someone else's customer, a different place) are shown as such and never offered as a review task.
    if (r > 0) return { ...base, play, split, stage: 'all_held', action: { label: `Review ${r} held lead${plural(r)}`, href: leadsHref }, line: `0 opportunities. ${r} lead${r === 1 ? ' needs' : 's need'} review.` }
    const q = play.query ? `/app/leads?q=${encodeURIComponent(play.query)}` : '/app/leads'
    const n = split.research.length
    return { ...base, play, split, stage: 'research_only', action: { label: 'Change the search', href: q }, line: `0 opportunities. ${n} research-only lead${plural(n)}: checking ${n === 1 ? 'it' : 'them'} cannot make ${n === 1 ? 'it' : 'them'} ready.` }
  }
  const n = split.opportunities.length
  // Drafts are read from this play's own campaign only; unknown drafts never borrow another campaign's count.
  if (i.drafts && i.drafts.drafts > 0) return { ...base, play, split, stage: 'useful', action: { label: `Review ${i.drafts.drafts} draft${i.drafts.drafts === 1 ? '' : 's'}`, href: `/app/outreach?job_id=${play.id}` }, line: `${n} opportunit${n === 1 ? 'y' : 'ies'} in this play.` }
  return { ...base, play, split, stage: 'useful', action: { label: `Review ${n} opportunit${n === 1 ? 'y' : 'ies'}`, href: leadsHref }, line: `${n} opportunit${n === 1 ? 'y' : 'ies'} in this play.` }
}

// The inline profile editor. List fields are shown joined with "; " (an entry such as "London, UK" keeps its comma), and
// a field the user did not change goes back exactly as it was stored, byte for byte: nothing untouched is re-split,
// trimmed or reordered. Only a changed list field is split again, on ";" only.
export type BuyerLists = 'who' | 'industries' | 'where' | 'sizes' | 'signals' | 'exclude'
export const LIST_FIELDS: BuyerLists[] = ['who', 'industries', 'where', 'sizes', 'signals', 'exclude']
export interface BuyerProfile { summary: string; who: string[]; industries: string[]; where: string[]; sizes: string[]; signals: string[]; exclude: string[] }
export const showList = (v: string[]) => v.join('; ')
const splitList = (s: string) => s.split(';').map(x => x.trim()).filter(Boolean)
export function editedBuyer(original: BuyerProfile, form: Record<BuyerLists | 'summary', string>): BuyerProfile {
  const out: BuyerProfile = { ...original, summary: form.summary === original.summary ? original.summary : form.summary.trim() }
  for (const k of LIST_FIELDS) out[k] = form[k] === showList(original[k]) ? original[k] : splitList(form[k])
  return out
}
