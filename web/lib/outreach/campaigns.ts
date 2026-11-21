import type Database from 'better-sqlite3'
import { sequenceAnalytics } from './sequences.ts'
import { evidenceStateOf } from './evidence-state.ts'
import { currentnessHeld, leadWindowHeld, windowHeld } from './currentness.ts'
import { requiredGateHeld, requiredGateHeldForJob } from '../scan/held-state.ts'
import type { Db } from '../db/client.ts'
import { reviewIsActionable, uncheckableCause } from '../lead-state.ts'
import { listQual } from '../run-status.ts'
import { approveBlockReason, draftBlockReason, sendBlockReason } from './service.ts'

// One row per search (a scan job is a campaign, as in the Outreach analytics): discovery -> qualification -> contact ->
// outreach -> sequence -> reply, and the single next action. Read-only and tenant-scoped: every count is limited to the
// signed-in user's own job and its leads. Counts are what is stored now; nothing here is a delivery or intent claim.

export interface Campaign {
  id: string; query: string; status: string; error: string | null; created_at: number
  discovery: { candidates: number | null; leads: number }
  // The same evidence states as the draft/send gates (evidence-state.ts): machine = quote found on the cited page,
  // human = confirmed by you, unverified = neither (and not in the review list). held = timing not confirmed yet.
  // needsReview = review-list leads a person's check can still make usable; research = review-list leads it cannot (no usable date under
  // your window, someone else's customer, a different place, a closed opening, a failed required check, an unknown reason - #683, the same
  // verdict as Home's journey: lib/lead-state.ts reviewIsActionable). heldResearch = the held leads no check can release (a subset of held,
  // drawn from EITHER sourceChecked or confirmedByYou leads - a lead confirmed out of an uncheckable hold is confirmedByYou, not sourceChecked).
  // heldResearchSourceChecked is the sourceChecked-only slice of heldResearch (#683 round 3): a reader squeezing this into one line (Home's
  // plays, readiness.ts) must subtract only this from sourceChecked, never all of heldResearch, or a clean source-checked lead can vanish
  // from the count whenever a DIFFERENT, confirmedByYou lead happens to be the held one.
  qualification: { sourceChecked: number; confirmedByYou: number; needsReview: number; research: number; unverified: number; held: number; heldResearch: number; heldResearchSourceChecked: number; rejected: number }
  // withContact: any live lead with a stored contact. readyWithContact: of those, the qualified ones (source-checked
  // or confirmed by you) whose timing is not held. draftable: leads every draft gate accepts right now, not yet drafted.
  contact: { withContact: number; readyWithContact: number; draftable: number }
  // Stored counts, then what the real gates say about them right now (approveBlockReason / sendBlockReason):
  // ready = the gate accepts it; setup = refused only for sender details or Gmail; held = refused for anything else.
  outreach: { drafts: number; approved: number; sent: number; draftsReady: number; draftsSetup: number; draftsHeld: number; approvedReady: number; approvedSetup: number; approvedHeld: number }
  sequence: { active: number; stopped: number }
  reply: { replied: number; interested: number; bounced: number; optOuts: number }
  next: { label: string; href: string | null }
}

// GET /api/campaigns?limit: 1-20, else the default 10. 20 = the Leads history's own size (lib/scan/store-db.ts listJobs), so the
// history (#1136) gets the current status of every scan it lists; never more (each row reads its leads' holds).
export function campaignsLimit(v: string | null): number {
  const n = Number(v ?? '')
  return v !== null && v.trim() !== '' && Number.isInteger(n) && n >= 1 ? Math.min(n, 20) : 10
}
export function listCampaigns(db: Database.Database, tenantId: string, limit = 10): Campaign[] {
  const jobs = db.prepare(`SELECT id, query, status, error, created_at, candidates FROM scan_jobs
    WHERE user_id = ? AND query IS NOT NULL AND query <> '' AND NOT (industry = 'test only' AND location = 'test only')
    ORDER BY created_at DESC, insert_seq DESC LIMIT ?`).all(tenantId, limit) as { id: string; query: string; status: string; error: string | null; created_at: number; candidates: number | null }[]
  return jobs.map(j => {
    const n = (sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { n: number }).n
    // Leads of THIS job of THIS tenant only (scan_jobs.user_id is the tenant).
    const L = `FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id AND j.user_id = ? WHERE l.scan_job_id = ?`
    const live = 'AND l.quarantined_at IS NULL'
    type Row = { id: string; contact: string | null; evidence_excerpt: string | null; confidence: number | null; human_confirmed_at: number | null; review_reason: string | null; human_confirmed_from: string | null; quarantined_at: number | null }
    const rows = db.prepare(`SELECT l.id, l.contact, l.evidence_excerpt, l.confidence, l.human_confirmed_at, l.review_reason, l.human_confirmed_from, l.quarantined_at ${L}`).all(tenantId, j.id) as Row[]
    const leads = rows.length
    const liveRows = rows.filter(r => r.quarantined_at === null)
    const rejected = leads - liveRows.length
    let sourceChecked = 0, confirmedByYou = 0, needsReview = 0, research = 0, unverified = 0
    for (const r of liveRows) {
      const st = evidenceStateOf(r)
      if (st === 'machine') sourceChecked++
      else if (st === 'human') confirmedByYou++
      else if (r.review_reason) {
        // A required check that has not passed outranks a reviewable reason: confirming the source cannot release it (#1062, the campaign page's verdict).
        if (reviewIsActionable({ review_reason: r.review_reason, window_held: leadWindowHeld(db, tenantId, r.id), gate_held: requiredGateHeld(db, tenantId, r.id) !== null })) needsReview++; else research++
      }
      else if (requiredGateHeld(db, tenantId, r.id) !== null) research++   // #1062: unverified, but held by a required check checking cannot release
      else unverified++
    }
    // The real gates, not a re-derivation: currentnessHeld is what holds drafting until timing is confirmed, and
    // draftBlockReason runs every createDraft check without writing. A stored contact alone never counts as ready.
    const heldIds = new Set(liveRows.filter(r => evidenceStateOf(r) !== 'unverified' && currentnessHeld(db, tenantId, r.id)).map(r => r.id))
    const held = heldIds.size
    // Of those, the ones only a hold no check can lift keeps: the time window, someone else's customer, a different place, a closed
    // opening (also when the user confirmed out of one), a failed required check. Reviewing the source cannot release them (#683).
    const heldResearchRows = liveRows.filter(r => heldIds.has(r.id) && (leadWindowHeld(db, tenantId, r.id) || !!uncheckableCause(r.review_reason) || !!uncheckableCause(r.human_confirmed_from) || requiredGateHeld(db, tenantId, r.id) !== null))
    const heldResearch = heldResearchRows.length
    // #683 round 3: the sourceChecked-only slice, so a one-line reader can subtract exactly the leads it is about to
    // stop calling sourceChecked, never a held-research lead that was confirmedByYou all along.
    const heldResearchSourceChecked = heldResearchRows.filter(r => evidenceStateOf(r) === 'machine').length
    const readyWithContact = liveRows.filter(r => evidenceStateOf(r) !== 'unverified' && !heldIds.has(r.id) && (r.contact ?? '').trim() !== '').length
    const withContact = n(`SELECT count(*) AS n ${L} ${live} AND coalesce(trim(l.contact), '') <> ''`, tenantId, j.id)
    const msg = (status: string) => n(`SELECT count(*) AS n FROM outreach_messages m JOIN leads l ON l.id = m.lead_id JOIN scan_jobs j ON j.id = l.scan_job_id AND j.user_id = ? WHERE m.tenant_id = ? AND l.scan_job_id = ? AND m.status = ? AND coalesce(m.test, 0) = 0`, tenantId, tenantId, j.id, status)
    // Test sends (outreach_messages.test) are fixtures, never real work: excluded from every count here.
    const drafts = msg('draft'), approved = msg('approved'), sent = msg('sent')
    const ids = (status: string) => (db.prepare(`SELECT m.id FROM outreach_messages m JOIN leads l ON l.id = m.lead_id JOIN scan_jobs j ON j.id = l.scan_job_id AND j.user_id = ? WHERE m.tenant_id = ? AND l.scan_job_id = ? AND m.status = ? AND coalesce(m.test, 0) = 0`).all(tenantId, tenantId, j.id, status) as { id: string }[]).map(r => r.id)
    // "setup" only when the account checks are the sole refusal: the same gate with them skipped must accept it.
    const sort = (list: string[], reason: (id: string, skipAccount: boolean) => string | null) => {
      const out = { ready: 0, setup: 0, held: 0 }
      for (const id of list) {
        const why = reason(id, false)
        if (why === null) out.ready++
        else if (SETUP.has(why) && reason(id, true) === null) out.setup++
        else out.held++
      }
      return out
    }
    const d = sort(ids('draft'), (id, skipAccount) => approveBlockReason(db, tenantId, id, { skipAccount }))
    const a = sort(ids('approved'), (id, skipAccount) => sendBlockReason(db, tenantId, id, { skipAccount }))
    const seq = (list: string) => n(`SELECT count(*) AS n FROM sequences s JOIN leads l ON l.id = s.lead_id JOIN scan_jobs j ON j.id = l.scan_job_id AND j.user_id = ? WHERE s.tenant_id = ? AND l.scan_job_id = ? AND s.status IN (${list})`, tenantId, tenantId, j.id)
    const leadIds = (db.prepare(`SELECT l.id ${L}`).all(tenantId, j.id) as { id: string }[]).map(r => r.id)
    const an = sequenceAnalytics(db, tenantId, leadIds)
    const interested = leadIds.length ? n(`SELECT count(DISTINCT thread_id) AS n FROM inbound_messages WHERE tenant_id = ? AND classification = 'positive' AND lead_id IN (${leadIds.map(() => '?').join(',')})`, tenantId, ...leadIds) : 0
    const drafted = new Set((db.prepare('SELECT lead_id FROM outreach_messages WHERE tenant_id = ?').all(tenantId) as { lead_id: string }[]).map(r => r.lead_id))
    const undrafted = liveRows.filter(r => !drafted.has(r.id) && draftBlockReason(db, tenantId, r.id) === null).length
    const c: Omit<Campaign, 'next'> = {
      id: j.id, query: j.query, status: j.status, error: j.error, created_at: j.created_at,
      discovery: { candidates: j.candidates, leads },
      qualification: { sourceChecked, confirmedByYou, needsReview, research, unverified, held, heldResearch, heldResearchSourceChecked, rejected },
      contact: { withContact, readyWithContact, draftable: undrafted },
      outreach: { drafts, approved, sent, draftsReady: d.ready, draftsSetup: d.setup, draftsHeld: d.held, approvedReady: a.ready, approvedSetup: a.setup, approvedHeld: a.held },
      sequence: { active: seq("'approved','active'"), stopped: seq("'replied','done','stopped'") },
      reply: { replied: an.replied, interested, bounced: an.bounced, optOuts: an.optOuts },
    }
    return { ...c, next: nextAction(c, undrafted) }
  })
}

// Refusals the user fixes once for the whole account (Home readiness / Settings), not per lead.
const SETUP = new Set(['sender_identity_missing', 'gmail_not_connected'])

const plural = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`

// The one thing to do next for a campaign, in pipeline order. It never runs ahead of a gate: review comes before
// drafting, approval before sending; the link goes to the page where that existing step and its checks live.
export function nextAction(c: Omit<Campaign, 'next'>, undrafted: number): Campaign['next'] {
  const leadsHref = `/app/leads?job_id=${c.id}`
  if (c.status === 'pending' || c.status === 'running') return { label: 'Search still running', href: leadsHref }
  if (c.status === 'failed') return { label: c.error === 'cancelled' ? 'Search cancelled. Run it again if you still want it' : 'Search failed. Open it to see why', href: leadsHref }
  if (c.qualification.needsReview > 0) return { label: `Check ${plural(c.qualification.needsReview, 'lead that needs', 'leads that need')} your review`, href: leadsHref }
  // Only what the approve/send gates accept right now is recommended; stored counts alone never are.
  if (c.outreach.draftsReady > 0) return { label: `Review and approve ${plural(c.outreach.draftsReady, 'draft', 'drafts')}`, href: '/app/outreach' }
  if (c.outreach.approvedReady > 0) return { label: `Send ${plural(c.outreach.approvedReady, 'approved email', 'approved emails')}`, href: '/app/outreach' }
  const setup = c.outreach.draftsSetup + c.outreach.approvedSetup
  if (setup > 0) return { label: `Add your sender details and connect Gmail to continue ${plural(setup, 'email', 'emails')}`, href: '/app' }
  if (c.reply.interested > 0) return { label: `Answer ${plural(c.reply.interested, 'interested reply', 'interested replies')}`, href: '/app/inbox' }
  // Every lead this search found has been rejected: none passed, whatever the scan recorded when it finished.
  if (c.discovery.leads > 0 && c.qualification.rejected >= c.discovery.leads) return { label: 'None passed: every lead was rejected. Try a broader search', href: '/app/leads' }
  if (undrafted > 0) return { label: `Approve ${plural(undrafted, 'lead', 'leads')} to draft emails`, href: leadsHref }
  // Only held leads a timing review can release are offered for review; the rest are research (#683).
  const heldReviewable = c.qualification.held - (c.qualification.heldResearch ?? 0)
  if (heldReviewable > 0) return { label: `Review the source of ${plural(heldReviewable, 'lead', 'leads')} to confirm timing`, href: leadsHref }
  const heldEmails = c.outreach.draftsHeld + c.outreach.approvedHeld
  if (heldEmails > 0) return { label: `${plural(heldEmails, 'email is', 'emails are')} held: open Outreach to see why`, href: '/app/outreach' }
  if (c.qualification.unverified > 0) return { label: `Check ${plural(c.qualification.unverified, 'unverified lead', 'unverified leads')} against their sources`, href: leadsHref }
  // Research only: checking cannot make these ready, so the step offered is one that can change the result - a new search (#352/#683).
  const research = (c.qualification.research ?? 0) + (c.qualification.heldResearch ?? 0)
  if (research > 0) return { label: `${plural(research, 'research-only lead', 'research-only leads')}: checking ${research === 1 ? 'it' : 'them'} cannot make ${research === 1 ? 'it' : 'them'} ready. Change the search`, href: `/app/leads?q=${encodeURIComponent(c.query)}` }
  if (c.discovery.leads === 0) return { label: 'No leads from this search. Try a broader one', href: '/app/leads' }
  return { label: 'Nothing waiting on you', href: null }
}

// The Leads history's current split (#1136, HIST-BATCH; Hermes-PC finding 2 / XHawk High): for the scans the history lists, only what the
// card's pill, label and next step need - discovery.leads and the qualification split listQual / currentRun read - in a bounded number
// of queries whatever the scan or lead count (the jobs, their leads, which scans have emails, and 3 gate reads per scan: at most 63 for the 20 scans the history lists), never the full per-lead /
// per-message campaign pipeline above. Same verdicts as listCampaigns (pinned by test/leads-history-1136.test.ts):
//  - needsReview / research: reviewIsActionable over window_held (windowHeld, pure) and gate_held (requiredGateHeldForJob, the campaign page's batch reader);
//  - heldResearch: a source-checked / confirmed lead held by its window, an uncheckable cause or a failed required check. Each of those
//    already makes currentnessHeld true, so this needs no per-lead timing-proof read; `held` (any timing hold) is not read by the card
//    and is not computed here (0).
// next: the Campaigns card's own nextAction where it needs no outreach read (see below); otherwise "Open its campaign". A scan id that is not this tenant's own non-test search is left out (its card keeps its record).
export type HistoryCampaign = Pick<Campaign, 'id' | 'query' | 'status' | 'error' | 'created_at' | 'qualification' | 'next'> & { discovery: { leads: number } }
export async function historyCampaigns(db: Database.Database, adb: Db, tenantId: string, jobIds: string[], now: Date = new Date()): Promise<HistoryCampaign[]> {
  const ids = [...new Set(jobIds)].slice(0, 20)
  if (!ids.length) return []
  const qs = ids.map(() => '?').join(',')
  const jobs = db.prepare(`SELECT id, query, status, error, created_at FROM scan_jobs
    WHERE user_id = ? AND id IN (${qs}) AND query IS NOT NULL AND query <> '' AND NOT (industry = 'test only' AND location = 'test only')
    ORDER BY created_at DESC, insert_seq DESC`).all(tenantId, ...ids) as { id: string; query: string; status: string; error: string | null; created_at: number }[]
  if (!jobs.length) return []
  type Row = { id: string; scan_job_id: string; evidence_excerpt: string | null; confidence: number | null; human_confirmed_at: number | null; review_reason: string | null; human_confirmed_from: string | null; quarantined_at: number | null; event_date: string | null; query: string | null; icp: string | null; run_budget: string | null }
  const jq = jobs.map(() => '?').join(',')
  const rows = db.prepare(`SELECT l.id, l.scan_job_id, l.evidence_excerpt, l.confidence, l.human_confirmed_at, l.review_reason, l.human_confirmed_from, l.quarantined_at, l.event_date, j.query, j.icp, j.run_budget
    FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id AND j.user_id = ? WHERE l.scan_job_id IN (${jq})`).all(tenantId, ...jobs.map(j => j.id)) as Row[]
  // the required-check verdict per listed scan (requiredGateHeldForJob: the campaign page's own reader, 3 reads per scan whatever its lead count)
  const gate = new Set<string>()
  for (const id of new Set(rows.map(r => r.scan_job_id))) for (const l of await requiredGateHeldForJob(adb, tenantId, id)) gate.add(l)
  // which listed scans have any email at all (one grouped read; test sends included, so "none" is certain)
  const mailed = new Set((db.prepare(`SELECT DISTINCT l.scan_job_id AS id FROM outreach_messages m JOIN leads l ON l.id = m.lead_id JOIN scan_jobs j ON j.id = l.scan_job_id AND j.user_id = ? WHERE m.tenant_id = ? AND l.scan_job_id IN (${jq})`).all(tenantId, tenantId, ...jobs.map(j => j.id)) as { id: string }[]).map(r => r.id))
  const byJob = new Map<string, Row[]>()
  for (const r of rows) { const a = byJob.get(r.scan_job_id) ?? []; a.push(r); byJob.set(r.scan_job_id, a) }
  return jobs.map(j => {
    const all = byJob.get(j.id) ?? []
    const live = all.filter(r => r.quarantined_at === null)
    let sourceChecked = 0, confirmedByYou = 0, needsReview = 0, research = 0, unverified = 0, heldResearch = 0, heldResearchSourceChecked = 0
    for (const r of live) {
      const st = evidenceStateOf(r), win = windowHeld(r, now), gh = gate.has(r.id)
      if (st === 'machine') sourceChecked++
      else if (st === 'human') confirmedByYou++
      else if (r.review_reason) { if (reviewIsActionable({ review_reason: r.review_reason, window_held: win, gate_held: gh })) needsReview++; else research++ }
      else if (gh) research++
      else unverified++
      if (st !== 'unverified' && (win || !!uncheckableCause(r.review_reason) || !!uncheckableCause(r.human_confirmed_from) || gh)) { heldResearch++; if (st === 'machine') heldResearchSourceChecked++ }
    }
    const qualification = { sourceChecked, confirmedByYou, needsReview, research, unverified, held: 0, heldResearch, heldResearchSourceChecked, rejected: all.length - live.length }
    const base = { id: j.id, query: j.query, status: j.status, error: j.error, created_at: j.created_at, discovery: { leads: all.length }, qualification }
    // The full card's next action exactly, wherever it needs no outreach read: a review a check can resolve comes first in nextAction; and a run
    // where nothing passed (after listQual) and no email was ever written has no drafts, approvals, replies, draftable or timing-reviewable
    // leads, so nextAction over zero outreach is the card's own step. Otherwise the campaign page holds the pipeline's next action.
    const q = listQual(qualification)
    const exact = needsReview > 0 || (q.sourceChecked + q.confirmedByYou === 0 && !mailed.has(j.id))
    const next = exact ? nextAction({ ...base, discovery: { candidates: null, leads: all.length }, contact: { withContact: 0, readyWithContact: 0, draftable: 0 }, outreach: { drafts: 0, approved: 0, sent: 0, draftsReady: 0, draftsSetup: 0, draftsHeld: 0, approvedReady: 0, approvedSetup: 0, approvedHeld: 0 }, sequence: { active: 0, stopped: 0 }, reply: { replied: 0, interested: 0, bounced: 0, optOuts: 0 } }, 0)
      : { label: 'Open its campaign', href: `/app/campaigns/${j.id}` }
    return { ...base, next }
  })
}
