// Display decisions for the leads list, kept in lib so the copy is unit-testable.
import { listQual, type ListQual } from '../run-status.ts'
import { heldState } from '../lead-state.ts'

// The empty-list line. A finished scan can have zero visible leads while lower-fit
// leads sit behind the "show lower-fit leads" toggle - say that instead of claiming
// the scan found nothing.
// repeatCount (#1238): ready leads that are collapsed behind "Show ... leads seen in your earlier scans". They passed verification, so
// "No leads passed verification" would contradict the scan's own "N source-checked" count on the same screen.
// pastScansWithLeads (#1579): with no scan open, the past scans in the page's own list that saved leads. "No leads yet" beside that list
// contradicted it (production 145d2eba), so the line points at the list instead.
export function emptyLeadsMessage(status: string, visibleCount: number, hiddenCount: number, needsReviewCount?: number | null, repeatCount = 0, pastScansWithLeads = 0): string | null {
  if (visibleCount > 0) return null
  if (status === 'pending') return 'This scan is queued and has not started yet. Leads appear here after it runs.'
  if (status === 'running') return 'This scan is still running. Leads appear here when it finishes.'
  if (status === 'enriching') return 'This scan is finishing contact and fit checks. Ready leads will appear here when those checks finish.'
  if (status === 'loading') return 'Loading this scan...'
  if (status === 'failed') return 'This scan ended without leads. See the message above.'
  if (status !== 'done') return pastScansWithLeads > 0 ? 'No scan is open. Your leads are in your past scans: open one to see them, or run a new scan.' : 'No leads yet. Run a scan.'
  if (repeatCount > 0) return `${repeatCount} lead${repeatCount === 1 ? '' : 's'} passed verification but ${repeatCount === 1 ? 'was' : 'were'} also found in your earlier scans - open "Show ${repeatCount} lead${repeatCount === 1 ? '' : 's'} seen in your earlier scans" below.`
  if (hiddenCount > 0) return `The scan found nothing above your fit bar - ${hiddenCount} lower-fit lead${hiddenCount === 1 ? ' is' : 's are'} hidden below.`
  // An all-review scan shows its cards below - 'no leads' would contradict them.
  if ((needsReviewCount ?? 0) > 0) return `No leads passed verification. ${needsReviewCount} need${needsReviewCount === 1 ? 's' : ''} your review below.`
  return 'The scan finished with no leads.'
}

// The ready list (#1238). Leads already shown in an earlier scan (seen_before) are tucked behind a toggle so a re-run surfaces what is NEW -
// but only when something new remains. When EVERY ready lead is a repeat, collapsing them all left the page with 0 cards while /api/leads
// and the counts above said "2 source-checked" (prod, chicago-law, 14 Nov). Then the repeats are shown, each still marked as seen before.
interface ReadyRow { review_reason?: string | null; seen_before?: number | boolean | null }
export function readyRepeats(leads: ReadyRow[]): { ready: number; repeats: number; collapsible: boolean } {
  const ready = leads.filter(l => !l.review_reason)
  const repeats = ready.filter(l => !!l.seen_before).length
  return { ready: ready.length, repeats, collapsible: repeats > 0 && repeats < ready.length }
}
export function visibleReadyLeads<T extends ReadyRow>(leads: T[], showSeen: boolean): T[] {
  const { collapsible } = readyRepeats(leads)
  return leads.filter(l => !l.review_reason && (showSeen || !collapsible || !l.seen_before))
}

// A lead with fit 0 is not a prospect (ICP mismatch). Showing its raw signal score
// next to the company name reads as "great lead", so say what the number means.
// A lead held at fit 0 because grading failed (no intent grade) is not "not a fit" -
// it was never graded, so the label says scoring failed instead.
// Leads saved by hand or from a job feed never get a grade; the stored 50 is only a column default.
// The headline next to a lead. Issue #198: "score 85" (the discovery relevance score) read as a hot lead while the
// grading said there was no reason to contact now (intent 0). A graded lead now shows its grade - fit, and whether a
// live trigger was confirmed - and the raw relevance score is only shown, labelled as such, for ungraded leads.
export function scoreLabel(score: number, fit: number | null, intent?: number | null, sourceKind?: string | null): string {
  if (fit == null && (sourceKind === 'hiring_feed' || sourceKind === 'manual_source' || sourceKind === 'first_party')) return 'not graded'
  if (fit === 0) return intent == null ? 'scoring failed' : 'not a fit'
  if (fit == null) return `relevance ${score} (not graded)`
  return `fit ${fit}/5${intent == null ? '' : intent === 0 ? ', no live trigger confirmed' : `, timing ${intent}/5`}`
}

// A literal page check that found the quote is a real stored fact; only its meaning, date and need stay unverified.
export function quoteNote(literalFound: boolean | undefined): { prefix: string; confirmed: string } {
  return literalFound
    ? { prefix: 'Quote found on the page by a literal check (its meaning, date and need are not verified): ', confirmed: 'confirmed by you - the quote was found on the page by a literal check; dazl did not verify its meaning, date or need' }
    : { prefix: 'Unconfirmed quote: ', confirmed: 'confirmed by you - dazl did not verify the quote' }
}

// The headline's timing sentence, from the SAME canonical timing state the badge uses (lib/scan/scoreboard.ts):
// a proof-backed lead never reads "timing unconfirmed", and an unconfirmed lead names the actual gap (#498). Proof
// of the event day is never buying need: every variant keeps need unconfirmed.
export function timingHeadline(t?: { timing: 'proof_backed' | 'unconfirmed'; reason?: import('./scoreboard.ts').TimingUnconfirmedReason | null }): string {
  if (t?.timing === 'proof_backed') return 'Event timing is from the cited source. Current need is unconfirmed.'
  switch (t?.reason) {
    case 'bad_date': return 'The claimed event date is invalid. Event timing and current need are unconfirmed.'
    case 'future_date': return 'The claimed event date is in the future. Event timing and current need are unconfirmed.'
    case 'out_of_window': return 'The event day is verified on the cited source and falls outside the requested freshness window. Current need is unconfirmed.' // reason order proves the day here
    case 'unresolved_recency_bound': return 'The request asks for a recent event but sets no time window, so event timing is unresolved. Current need is unconfirmed.'
    case 'proof_kind_mismatch': return 'The saved date proof does not belong to this kind of signal. Event timing and current need are unconfirmed.'
    default: return 'Event timing and current need are unconfirmed.'
  }
}

export function reviewTimingCopy(reason: string, note?: string | null): string {
  return [reason.trim(), note?.trim()].filter((part): part is string => Boolean(part))
    .map(part => /[.!?]$/.test(part) ? part : `${part}.`).join(' ')
}

// Read-time copy for the saved rationale (leads API). "No saved grade" must not be shown next to a saved fit/intent/action
// grade: a grade can exist without a written rationale (#198 live acceptance finding).
export function savedGradeWhy(l: { why?: string | null; fit?: number | null; intent?: number | null; action?: number | null }, t?: { timing: 'proof_backed' | 'unconfirmed'; reason?: import('./scoreboard.ts').TimingUnconfirmedReason | null }): string {
  if (l.why) return `${timingHeadline(t)} Saved grades are historical, not a currentness verdict.`
  const parts = [['fit', l.fit], ['intent', l.intent], ['action', l.action]].filter(([, v]) => v != null).map(([k, v]) => `${k} ${v}`)
  return parts.length ? `A saved grade exists (${parts.join(', ')}) but no written rationale was saved. ${timingHeadline(t)}` : `This lead has no saved grade. ${timingHeadline(t)}`
}

// The watch list on the Leads page (#1579). It is the whole account's list and is the same on every search's page, where it sits
// under that search's own "Settings for this play": the heading says whose it is, and on a search's page one line says it is not that
// search's setting.
export function repeatingSearchesCopy(onSearchPage: boolean): { heading: string; scope: string | null } {
  return { heading: 'Your repeating searches (all searches)', scope: onSearchPage ? 'This list covers your whole account and is the same on every search. It is not a setting of the search open on this page.' : null }
}

// The count line above an older-engine search's leads (#1238/#1062/#1620). It used to print the funnel the scan RECORDED when it finished
// (scan_jobs.candidates / verified / needs_review), while Campaigns, its card in the Leads history and Home count the saved leads as they
// stand now. On production (d9fa0e71, scan 5a27e8cb) the header said "10 found, 5 need your review" beside Campaigns' "6 found, 1 needs
// your review": 10 counted the 4 candidates the scan dropped, and 4 of the 5 reviews were reasons no check can resolve (research only).
// With the scan's current split (`current`: GET /api/campaigns?view=history, historyCampaigns - the Campaigns card's own numbers) the
// line says those numbers; the recorded dropped count stays, since dropped candidates were never saved as leads. Without it (the read
// failed, or the scan is not in that list) the recorded funnel is shown and marked as recorded.
export interface RecordedQuality { candidates: number; passed: number | null; needs_review: number | null; dropped: number | null }
export interface CurrentScanSplit { discovery: { leads: number }; qualification: ListQual }
export function scanCountTags(recorded: RecordedQuality, current?: CurrentScanSplit | null): { tags: string[]; needsReview: number; current: boolean } {
  const dropped = `${recorded.dropped ?? 0} dropped`
  const review = (n: number) => `${n} need${n === 1 ? 's' : ''} your review`
  if (!current) {
    const n = recorded.needs_review ?? 0
    return { tags: [`${recorded.candidates} found`, `${recorded.passed ?? 0} source-checked`, review(n), dropped], needsReview: n, current: false }
  }
  const q = listQual(current.qualification)
  const tags = [`${current.discovery.leads} found`, `${q.sourceChecked} source-checked`]
  if (q.confirmedByYou > 0) tags.push(`${q.confirmedByYou} confirmed by you`)
  tags.push(review(q.needsReview))
  if (q.research > 0) tags.push(`${q.research} research only`)
  if (q.unverified > 0) tags.push(`${q.unverified} unverified`)
  if (q.rejected > 0) tags.push(`${q.rejected} rejected`)
  tags.push(dropped)
  return { tags, needsReview: q.needsReview, current: true }
}

// The list under the cards: every lead that carries a review reason, split by the ONE verdict the count line above it, Campaigns and Home
// count by (lib/lead-state.ts heldState: reviewIsActionable with the time window, a required check and the buyer; a new-engine lead by its
// one state). Production (2026-11-24, an older-engine search): the chips said "1 needs your review, 4 research only" above ONE list headed
// "Needs your review" holding all 5, because the list asked only "does any row have a confirm action" (lib/scan/review-action.ts, which
// knows nothing of the buyer rule). review = a person's check can still make the lead usable; research = every other lead that carries a
// reason (a rejected one included: it is never a review item).
export function reviewListSplit<L extends { review_reason?: string | null }>(leads: readonly L[]): { review: L[]; research: L[] } {
  const review: L[] = [], research: L[] = []
  for (const l of leads) {
    if (!l.review_reason) continue
    if (heldState(l as never)?.state === 'review') review.push(l)
    else research.push(l)
  }
  return { review, research }
}

// The repeating-searches box on Leads: the count beside a search is its LAST run's new leads (lib/watch.ts listWatches), while the Plays
// page's pill adds up every finished run since the person last checked (lib/play-new-view.ts newLabel). Production (2026-11-24): "8 new
// leads so far" on Plays beside a bare "4 new" here for the same play. Both are right; this one now says which run it counts.
export const lastRunNewLabel = (n: number): string => n > 0 ? `last run: ${n} new` : 'last run: nothing new'
