import type Database from 'better-sqlite3'
import { sequenceAnalytics } from './sequences.ts'
import { evidenceStateOf } from './evidence-state.ts'
import { currentnessHeld, leadWindowHeld, windowHeld } from './currentness.ts'
import { requiredGateHeld, requiredGateHeldForJob } from '../scan/held-state.ts'
import { sqliteDb, type Db } from '../db/client.ts'
import { hasCompanyFirstBudget } from '../company-first/product-discovery.ts'
import { companyFirstResults } from '../scan/company-first-results.ts'
import { enrichState } from '../scan/enrichment.ts'
import { reviewIsActionable, uncheckableCause } from '../lead-state.ts'
import { discoverCounts, discoverLinkedIn, type DiscoverCounts } from '../discover/card.ts'
import { DISCOVER_LEAD_COLUMNS, discoverNoTable, discoverStatesFromRows, discoverStatesOfDb, discoverStoredSql, type DiscoverStoredRow } from '../discover/state-db.ts'
import { buyerUnreachable, buyerUnreachableFrom, buyerReachSql, noTable, type ReachRow } from '../people/buyer-reach.ts'
import { listQual } from '../run-status.ts'
import { approveBlockReason, manualDraftBlockReason, sendBlockReason } from './service.ts'

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
  // heldByChecks (#1062): EVERY live lead of a company-first scan that its final checks keep off the run page, /api/leads and the CSV
  // (companyFirstResults().visibleIds, the same gate) - the run page's own held count. Each is also inside research or heldResearch, never
  // any other bucket: one the other checks would still call reviewable, passed or unverified is counted as research; one they already call
  // research or heldResearch (its window, an uncheckable cause) keeps that verdict. No check a person can do releases them, so they are
  // never "needs your review", and the next step names them all (live check on prod 23c6533: "2 research-only leads" beside 3 held).
  // A lead from the new engine (source_kind 'discover') is counted by its ONE state (lib/discover/card.ts discoverState), never by the rules
  // above: ready (by email or on LinkedIn) is in sourceChecked, review in needsReview, research in research, rejected in rejected, and
  // noContact holds the ones whose proof is fine but nobody can be reached yet. discover = those leads' own counts, as every page says them.
  qualification: { sourceChecked: number; confirmedByYou: number; needsReview: number; research: number; unverified: number; held: number; heldResearch: number; heldResearchSourceChecked: number; rejected: number; heldByChecks?: number; noContact?: number; discover?: DiscoverCounts }
  // withContact: any live lead with a stored contact. readyWithContact: of those, the qualified ones (source-checked
  // or confirmed by you) whose timing is not held. draftable: leads every draft gate accepts right now, not yet drafted.
  // linkedinOnly (#1583): leads Approve cannot draft an email for, whose named person's own LinkedIn profile is known and whose proof
  // holds - the card offers "Message on LinkedIn" (lib/discover/card.ts discoverLinkedIn). The user writes and sends that message.
  contact: { withContact: number; readyWithContact: number; draftable: number; linkedinOnly?: number }
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
type CampaignJob = { id: string; query: string; status: string; error: string | null; created_at: number; candidates: number | null; run_budget: string | null; enrich_started_at: number | null; enrich_finished_at: number | null }
// One read of the listed scans: status, budget and enrichment marks come from the same row read, and every verdict on a scan is made from it
// (#1062, Qodo on #1466: a second read could see a scan that finished in between and judge it against the first read's visibility).
const campaignJobs = (db: Database.Database, tenantId: string, limit: number) => db.prepare(`SELECT id, query, status, error, created_at, candidates, run_budget, enrich_started_at, enrich_finished_at FROM scan_jobs
    WHERE user_id = ? AND query IS NOT NULL AND query <> '' AND NOT (industry = 'test only' AND location = 'test only')
    ORDER BY created_at DESC, insert_seq DESC LIMIT ?`).all(tenantId, limit) as CampaignJob[]

// #1062: the leads a company-first scan shows anywhere (run page, /api/leads, CSV, campaign page) are companyFirstResults().visibleIds.
// Every count reads the same set, per company-first scan in `jobs`. A scan whose result cannot be read (still running, a rescan in
// progress, a missing table) shows nothing, so it gets an empty set: fail closed, never "all stored leads".
// A done scan's final checks run in its enrichment stage (companyFirstResults computes visibility only once it finished - lib/scan/enrichment.ts
// enrichState). 'checking': the stage is running, so the card says the search is still running. 'unfinished': the stage was interrupted or
// never started, so the checks never ran: the card says so. Either way its leads stay held, never reviewable and never "held by checks".
// A pending, running, failed or cancelled scan gets the fail-closed empty set and nextAction's own label for that status.
export type CompanyFirstShown = ReadonlyMap<string, ReadonlySet<string> | 'checking' | 'unfinished'>
// `jobs` is the caller's one read of these scans (status and enrichment marks included); every verdict here is made from it.
export type ShownJob = { id: string; run_budget: string | null; status: string; enrich_started_at: number | null; enrich_finished_at: number | null }
export const companyFirstShown = (db: Database.Database, tenantId: string, jobs: readonly ShownJob[], now: Date = new Date()): Promise<CompanyFirstShown> =>
  companyFirstShownDb(sqliteDb(db), tenantId, jobs, now)
// The same, on the async Db layer (Home's results read; SQLite and Postgres). A store without the company-first reader returns null: not final,
// so 'checking' - fail closed, its leads are shown nowhere.
export async function companyFirstShownDb(db: Db, tenantId: string, jobs: readonly ShownJob[], now: Date = new Date()): Promise<CompanyFirstShown> {
  const out = new Map<string, ReadonlySet<string> | 'checking' | 'unfinished'>()
  for (const j of jobs) {
    if (!hasCompanyFirstBudget(j.run_budget)) continue   // no read at all for other scans (#1136 HIST-BATCH query bound)
    if (j.status !== 'done') { out.set(j.id, new Set()); continue }
    if (j.enrich_finished_at == null) { out.set(j.id, enrichState(j, Math.floor(now.getTime() / 1000)) === 'running' ? 'checking' : 'unfinished'); continue }
    // finished in this read: the visible set, but only from a visibility read that itself saw the stage finished (results.final). If a new
    // attempt started or the scan changed since this read, that read is not this scan's final result: still checking, never "all held".
    const r = await companyFirstResults(db, tenantId, j.id, now)
    out.set(j.id, r?.final ? r.visibleIds : 'checking')
  }
  return out
}
// The next step for a done company-first scan whose final checks have not finished; null when they have (or it is not company-first).
const checksPending = (j: { id: string; query: string; run_budget: string | null }, shown: CompanyFirstShown): Campaign['next'] | null => {
  if (!hasCompanyFirstBudget(j.run_budget)) return null
  const v = shown.get(j.id)
  if (v === 'checking') return { label: 'Search still running', href: `/app/leads?job_id=${j.id}` }
  if (v === 'unfinished') return { label: 'Final checks did not finish, so no lead can be shown. Run the search again', href: `/app/leads?q=${encodeURIComponent(j.query)}` }
  return null
}
// Is this lead outside what its company-first scan shows? Not company-first: never. Company-first without a read in `shown`: always (fail closed).
export const heldByChecksOf = (j: { id: string; run_budget: string | null }, shown: CompanyFirstShown) =>
  hasCompanyFirstBudget(j.run_budget) ? (id: string) => { const v = shown.get(j.id); return !(v instanceof Set && v.has(id)) } : () => false
// Home's hold reason (lib/journey.ts heldReason's words) for a lead heldByChecksOf hides: its scan's final checks held it, or they have not
// finished yet. Never "needs your review": no check a person can do releases it.
export const gateHoldReason = (j: { id: string }, shown: CompanyFirstShown): string =>
  shown.get(j.id) instanceof Set ? 'held by the final checks' : 'final checks not finished'

// The Campaigns list with the company-first gate read (GET /api/campaigns).
export async function listCampaignsNow(db: Database.Database, tenantId: string, limit = 10, now: Date = new Date()): Promise<Campaign[]> {
  const jobs = campaignJobs(db, tenantId, limit)
  return listCampaigns(db, tenantId, limit, await companyFirstShown(db, tenantId, jobs, now), jobs)
}
// `shown`: companyFirstShown for these scans. Without it, every lead of a company-first scan counts as held by checks (fail closed).
// `jobs`: the read `shown` was made from (listCampaignsNow passes it); read here only when called on its own.
export function listCampaigns(db: Database.Database, tenantId: string, limit = 10, shown: CompanyFirstShown = new Map(), jobs: readonly CampaignJob[] = campaignJobs(db, tenantId, limit)): Campaign[] {
  return jobs.map(j => {
    const n = (sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { n: number }).n
    // Leads of THIS job of THIS tenant only (scan_jobs.user_id is the tenant).
    const L = `FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id AND j.user_id = ? WHERE l.scan_job_id = ?`
    type Row = { id: string; scan_job_id: string; contact: string | null; evidence_excerpt: string | null; confidence: number | null; human_confirmed_at: number | null; review_reason: string | null; human_confirmed_from: string | null; quarantined_at: number | null; name: string | null; company_domain: string | null; event_date: string | null; fit: number | null; intent: number | null; source_kind: string | null }
    const every = db.prepare(`SELECT l.id, l.scan_job_id, l.contact, l.evidence_excerpt, l.confidence, l.human_confirmed_at, l.review_reason, l.human_confirmed_from, l.quarantined_at, ${DISCOVER_LEAD_COLUMNS} ${L}`).all(tenantId, j.id) as Row[]
    // #1238: the new engine's leads have ONE state each (lib/discover/card.ts discoverState). They are counted from it below and are
    // left out of the older engine's rules, which `rows` and everything derived from it keep exactly as they were.
    let dStored: DiscoverStoredRow[] = []
    if (every.some(r => r.source_kind === 'discover')) try { dStored = db.prepare(discoverStoredSql(1)).all(tenantId, tenantId, j.id) as DiscoverStoredRow[] } catch (e) { dStored = discoverNoTable(e) }
    const dStates = discoverStatesFromRows(every, dStored).get(j.id)
    const dc = dStates ? discoverCounts(dStates.values()) : null
    const rows = dStates ? every.filter(r => !dStates.has(r.id)) : every
    const leads = every.length
    const allLive = rows.filter(r => r.quarantined_at === null)
    const rejected = rows.length - allLive.length + (dc?.rejected ?? 0)
    // #1062: a lead the company-first gate keeps off every page that the checks below would still count as reviewable, passed or
    // unverified is held by checks and nothing else (inside research); one they already count as research keeps that verdict.
    const byChecks = heldByChecksOf(j, shown)
    const gateHeld = (r: Row) => requiredGateHeld(db, tenantId, r.id) !== null
    // #1037: a review that cannot give the lead its buyer cannot make it ready (lib/people/buyer-reach.ts, Home's own answer)
    let reach: ReachRow[]
    try { reach = db.prepare(buyerReachSql(1)).all(tenantId, tenantId, j.id) as ReachRow[] } catch (e) { reach = noTable(e) }
    const noBuyer = buyerUnreachableFrom(rows.filter(r => r.review_reason), reach)
    const alreadyResearch = (r: Row) => evidenceStateOf(r) === 'unverified'
      ? (r.review_reason ? !reviewIsActionable({ review_reason: r.review_reason, window_held: leadWindowHeld(db, tenantId, r.id), gate_held: gateHeld(r), buyer_unreachable: noBuyer.has(r.id) }) : gateHeld(r))
      : currentnessHeld(db, tenantId, r.id) && (leadWindowHeld(db, tenantId, r.id) || !!uncheckableCause(r.review_reason) || !!uncheckableCause(r.human_confirmed_from) || gateHeld(r))
    const liveRows = allLive.filter(r => !byChecks(r.id) || alreadyResearch(r))
    const heldByChecks = allLive.filter(r => byChecks(r.id)).length
    let sourceChecked = 0, confirmedByYou = 0, needsReview = 0, research = allLive.length - liveRows.length, unverified = 0
    for (const r of liveRows) {
      const st = evidenceStateOf(r)
      if (st === 'machine') sourceChecked++
      else if (st === 'human') confirmedByYou++
      else if (r.review_reason) {
        // A required check that has not passed outranks a reviewable reason: confirming the source cannot release it (#1062, the campaign page's verdict).
        if (reviewIsActionable({ review_reason: r.review_reason, window_held: leadWindowHeld(db, tenantId, r.id), gate_held: requiredGateHeld(db, tenantId, r.id) !== null, buyer_unreachable: noBuyer.has(r.id) })) needsReview++; else research++
      }
      else if (requiredGateHeld(db, tenantId, r.id) !== null) research++   // #1062: unverified, but held by a required check checking cannot release
      else unverified++
    }
    // The real gates, not a re-derivation: currentnessHeld is what holds drafting until timing is confirmed, and
    // manualDraftBlockReason runs every check the Approve button's createDraft makes, without writing. A stored contact alone never counts as ready.
    const heldIds = new Set(liveRows.filter(r => evidenceStateOf(r) !== 'unverified' && currentnessHeld(db, tenantId, r.id)).map(r => r.id))
    const held = heldIds.size
    // Of those, the ones only a hold no check can lift keeps: the time window, someone else's customer, a different place, a closed
    // opening (also when the user confirmed out of one), a failed required check. Reviewing the source cannot release them (#683).
    const heldResearchRows = liveRows.filter(r => heldIds.has(r.id) && (leadWindowHeld(db, tenantId, r.id) || !!uncheckableCause(r.review_reason) || !!uncheckableCause(r.human_confirmed_from) || requiredGateHeld(db, tenantId, r.id) !== null))
    const heldResearch = heldResearchRows.length
    // #683 round 3: the sourceChecked-only slice, so a one-line reader can subtract exactly the leads it is about to
    // stop calling sourceChecked, never a held-research lead that was confirmedByYou all along.
    const heldResearchSourceChecked = heldResearchRows.filter(r => evidenceStateOf(r) === 'machine').length
    // A discovery lead is "with a contact" exactly when it is ready, by email or on LinkedIn (discoverState): the card's own actions. It used
    // to count here whenever an address or a profile was stored, also while its proof held it, so the card said "1 with a contact" beside a
    // Leads page that offered no action for any lead (#1238, staging 96111ddd). A shared inbox or another employee's address is never one (#1250).
    if (dc) { sourceChecked += dc.ready; needsReview += dc.review; research += dc.research }
    const hasContact = (r: Row) => (r.contact ?? '').trim() !== ''
    const readyWithContact = liveRows.filter(r => evidenceStateOf(r) !== 'unverified' && !heldIds.has(r.id) && hasContact(r)).length + (dc?.ready ?? 0)
    const withContact = allLive.filter(hasContact).length + (dc?.ready ?? 0)
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
    // a discovery lead can be drafted only when it is ready by email; #1583: the gate read is the Approve button's own (a person asks for
    // the draft). Every draft is made by hand during the beta.
    const emailReady = dStates ? every.filter(r => dStates.get(r.id) === 'ready_email') : []
    const undrafted = [...liveRows, ...emailReady].filter(r => !byChecks(r.id) && !drafted.has(r.id) && manualDraftBlockReason(db, tenantId, r.id) === null).length
    // The card can offer manual LinkedIn outreach even when no email makes a lead Ready.
    const storedByLead = new Map<string, DiscoverStoredRow[]>()
    for (const row of dStored) {
      const stored = storedByLead.get(row.lead_id) ?? []
      stored.push(row)
      storedByLead.set(row.lead_id, stored)
    }
    const linkedinOnly = every.filter(row => dStates?.get(row.id) === 'no_contact' && !byChecks(row.id) &&
      discoverLinkedIn({ ...row, enrichments: storedByLead.get(row.id) })).length
    const c: Omit<Campaign, 'next'> = {
      id: j.id, query: j.query, status: j.status, error: j.error, created_at: j.created_at,
      discovery: { candidates: j.candidates, leads },
      qualification: { sourceChecked, confirmedByYou, needsReview, research, unverified, held, heldResearch, heldResearchSourceChecked, rejected, heldByChecks, ...(dc ? { noContact: dc.no_contact, discover: dc } : {}) },
      contact: { withContact, readyWithContact, draftable: undrafted, ...(linkedinOnly > 0 ? { linkedinOnly } : {}) }, // linkedinOnly only when there is one: absent reads as none
      outreach: { drafts, approved, sent, draftsReady: d.ready, draftsSetup: d.setup, draftsHeld: d.held, approvedReady: a.ready, approvedSetup: a.setup, approvedHeld: a.held },
      sequence: { active: seq("'approved','active'"), stopped: seq("'replied','done','stopped'") },
      reply: { replied: an.replied, interested, bounced: an.bounced, optOuts: an.optOuts },
    }
    return { ...c, next: checksPending(j, shown) ?? nextAction(c, undrafted) }
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
  // The person can still be reached manually on LinkedIn (#1583).
  // dazl opens the profile; the user sends the message.
  const linkedin = c.contact.linkedinOnly ?? c.qualification.discover?.ready_linkedin ?? 0
  if (linkedin > 0) return { label: `Message ${plural(linkedin, 'lead', 'leads')} on LinkedIn: open ${linkedin === 1 ? 'the lead' : 'each lead'} and use "Message on LinkedIn"`, href: leadsHref }
  // Only held leads a timing review can release are offered for review; the rest are research (#683).
  const heldReviewable = c.qualification.held - (c.qualification.heldResearch ?? 0)
  if (heldReviewable > 0) return { label: `Review the source of ${plural(heldReviewable, 'lead', 'leads')} to confirm timing`, href: leadsHref }
  const heldEmails = c.outreach.draftsHeld + c.outreach.approvedHeld
  if (heldEmails > 0) return { label: `${plural(heldEmails, 'email is', 'emails are')} held: open Outreach to see why`, href: '/app/outreach' }
  if (c.qualification.unverified > 0) return { label: `Check ${plural(c.qualification.unverified, 'unverified lead', 'unverified leads')} against their sources`, href: leadsHref }
  // New-engine leads whose proof is fine but nobody can be reached yet: they are not research, so the step is to open them.
  const noContact = c.qualification.noContact ?? 0
  if (noContact > 0) return { label: `${plural(noContact, 'lead has', 'leads have')} proof but no contact yet. Open the search to see ${noContact === 1 ? 'it' : 'them'}`, href: leadsHref }
  // Research only: checking cannot make these ready, so the step offered is one that can change the result - a new search (#352/#683).
  // #1062: leads held by a company-first scan's checks are all inside research / heldResearch; they get their own read-only step, which counts
  // every one of them (the run page lists them with why), and only the other research-only leads get the research step.
  const byChecks = c.qualification.heldByChecks ?? 0
  const research = (c.qualification.research ?? 0) + (c.qualification.heldResearch ?? 0) - byChecks
  if (research > 0) {
    const why = `${plural(research, 'research-only lead', 'research-only leads')}: checking ${research === 1 ? 'it' : 'them'} cannot make ${research === 1 ? 'it' : 'them'} ready.`
    // #1579: a search that still has leads that passed is not one to replace. Its step opens that search, as every other step about its
    // own leads does; only a search where nothing passed offers a new one (the same rule as the run's own status, lib/run-status.ts currentRun).
    const q = listQual(c.qualification), passed = q.sourceChecked + q.confirmedByYou
    if (passed > 0) return { label: `${why} Open the search to see the ${plural(passed, 'lead', 'leads')} that passed`, href: leadsHref }
    return { label: `${why} Change the search`, href: `/app/leads?q=${encodeURIComponent(c.query)}` }
  }
  if (byChecks > 0) return { label: `${plural(byChecks, 'lead is', 'leads are')} held by checks (read-only): open the run to see why`, href: leadsHref }
  if (c.discovery.leads === 0) return { label: 'No leads from this search. Try a broader one', href: '/app/leads' }
  return { label: 'Nothing waiting on you', href: null }
}

// The Leads history's current split (#1136, HIST-BATCH; Hermes-PC finding 2 / XHawk High): for the scans the history lists, only what the
// card's pill, label and next step need - discovery.leads and the qualification split listQual / currentRun read - in a bounded number
// of queries whatever the scan or lead count (the jobs, their leads, which scans have emails, and 3 gate reads per scan: at most 63 for the 20 scans the history lists; #1062: plus, per company-first scan only, its companyFirstResults read - the run page's own gate, bounded by its 200-lead list), never the full per-lead /
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
  const jobs = db.prepare(`SELECT id, query, status, error, created_at, run_budget, enrich_started_at, enrich_finished_at FROM scan_jobs
    WHERE user_id = ? AND id IN (${qs}) AND query IS NOT NULL AND query <> '' AND NOT (industry = 'test only' AND location = 'test only')
    ORDER BY created_at DESC, insert_seq DESC`).all(tenantId, ...ids) as { id: string; query: string; status: string; error: string | null; created_at: number; run_budget: string | null; enrich_started_at: number | null; enrich_finished_at: number | null }[]
  if (!jobs.length) return []
  const shown = await companyFirstShown(db, tenantId, jobs, now)
  type Row = { id: string; scan_job_id: string; contact: string | null; evidence_excerpt: string | null; confidence: number | null; human_confirmed_at: number | null; review_reason: string | null; human_confirmed_from: string | null; quarantined_at: number | null; event_date: string | null; query: string | null; icp: string | null; run_budget: string | null; name: string | null; company_domain: string | null; fit: number | null; intent: number | null; source_kind: string | null }
  const jq = jobs.map(() => '?').join(',')
  const rows = db.prepare(`SELECT l.id, l.scan_job_id, l.contact, l.evidence_excerpt, l.confidence, l.human_confirmed_at, l.review_reason, l.human_confirmed_from, l.quarantined_at, j.query, j.icp, j.run_budget, ${DISCOVER_LEAD_COLUMNS}
    FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id AND j.user_id = ? WHERE l.scan_job_id IN (${jq})`).all(tenantId, ...jobs.map(j => j.id)) as Row[]
  // the required-check verdict per listed scan (requiredGateHeldForJob: the campaign page's own reader, 3 reads per scan whatever its lead count)
  const gate = new Set<string>()
  for (const id of new Set(rows.map(r => r.scan_job_id))) for (const l of await requiredGateHeldForJob(adb, tenantId, id)) gate.add(l)
  // #1037: the leads no review can give a buyer (lib/people/buyer-reach.ts, Home's own answer), one batched read
  const noBuyer = await buyerUnreachable(adb, tenantId, jobs.map(j => j.id), rows.filter(r => r.review_reason))
  // which listed scans have any email at all (one grouped read; test sends included, so "none" is certain)
  const mailed = new Set((db.prepare(`SELECT DISTINCT l.scan_job_id AS id FROM outreach_messages m JOIN leads l ON l.id = m.lead_id JOIN scan_jobs j ON j.id = l.scan_job_id AND j.user_id = ? WHERE m.tenant_id = ? AND l.scan_job_id IN (${jq})`).all(tenantId, tenantId, ...jobs.map(j => j.id)) as { id: string }[]).map(r => r.id))
  const byJob = new Map<string, Row[]>()
  for (const r of rows) { const a = byJob.get(r.scan_job_id) ?? []; a.push(r); byJob.set(r.scan_job_id, a) }
  // #1238: the new engine's leads, each by its ONE state (one more read, and only when a listed scan has such a lead); the older rules below never see them
  const dAll = await discoverStatesOfDb(adb, tenantId, rows)
  return jobs.map(j => {
    const found = byJob.get(j.id) ?? []
    const dStates = dAll.get(j.id), dc = dStates ? discoverCounts(dStates.values()) : null
    const all = dStates ? found.filter(r => !dStates.has(r.id)) : found
    // #1062: the same company-first gate and rule as listCampaigns: a hidden lead these checks would not already call research is held by checks.
    const byChecks = heldByChecksOf(j, shown)
    const allLive = all.filter(r => r.quarantined_at === null)
    let sourceChecked = 0, confirmedByYou = 0, needsReview = 0, research = 0, unverified = 0, heldResearch = 0, heldResearchSourceChecked = 0, heldByChecks = 0
    for (const r of allLive) {
      const st = evidenceStateOf(r), win = windowHeld(r, now), gh = gate.has(r.id)
      const heldRes = st !== 'unverified' && (win || !!uncheckableCause(r.review_reason) || !!uncheckableCause(r.human_confirmed_from) || gh)
      if (byChecks(r.id)) heldByChecks++
      if (byChecks(r.id) && !(st === 'unverified' ? (r.review_reason ? !reviewIsActionable({ review_reason: r.review_reason, window_held: win, gate_held: gh, buyer_unreachable: noBuyer.has(r.id) }) : gh) : heldRes)) { research++; continue }
      if (st === 'machine') sourceChecked++
      else if (st === 'human') confirmedByYou++
      else if (r.review_reason) { if (reviewIsActionable({ review_reason: r.review_reason, window_held: win, gate_held: gh, buyer_unreachable: noBuyer.has(r.id) })) needsReview++; else research++ }
      else if (gh) research++
      else unverified++
      if (heldRes) { heldResearch++; if (st === 'machine') heldResearchSourceChecked++ }
    }
    if (dc) { sourceChecked += dc.ready; needsReview += dc.review; research += dc.research }
    const qualification = { sourceChecked, confirmedByYou, needsReview, research, unverified, held: 0, heldResearch, heldResearchSourceChecked, rejected: all.length - allLive.length + (dc?.rejected ?? 0), heldByChecks, ...(dc ? { noContact: dc.no_contact, discover: dc } : {}) }
    const base = { id: j.id, query: j.query, status: j.status, error: j.error, created_at: j.created_at, discovery: { leads: found.length }, qualification }
    // The full card's next action exactly, wherever it needs no outreach read: a review a check can resolve comes first in nextAction; and a run
    // where nothing passed (after listQual) and no email was ever written has no drafts, approvals, replies, draftable or timing-reviewable
    // leads, so nextAction over zero outreach is the card's own step. Otherwise the campaign page holds the pipeline's next action.
    const q = listQual(qualification)
    const exact = needsReview > 0 || (q.sourceChecked + q.confirmedByYou === 0 && !mailed.has(j.id))
    const next = checksPending(j, shown) ?? (exact ? nextAction({ ...base, discovery: { candidates: null, leads: found.length }, contact: { withContact: 0, readyWithContact: 0, draftable: 0 }, outreach: { drafts: 0, approved: 0, sent: 0, draftsReady: 0, draftsSetup: 0, draftsHeld: 0, approvedReady: 0, approvedSetup: 0, approvedHeld: 0 }, sequence: { active: 0, stopped: 0 }, reply: { replied: 0, interested: 0, bounced: 0, optOuts: 0 } }, 0)
      : { label: 'Open its campaign', href: `/app/campaigns/${j.id}` })
    return { ...base, next }
  })
}
