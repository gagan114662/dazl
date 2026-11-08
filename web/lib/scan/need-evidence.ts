// Buying-need evidence for a NEW search's records (#401 demand gate, extends #379's source-backed hypotheses).
//
// What this is: when a search's ordinary write stage stores its leads, this module also records, per lead, what the
// search actually proved about BUYING NEED for the play's offer - and a tenant-scoped reader (currentBuyingNeed) that
// revalidates that record against the CURRENT rubric, plan and domain evidence before anyone relies on it.
//
// Two bases, and only two:
//   - demand_post: the lead's source artifact is a demand-signal post (today: the Reddit competitor-complaint
//     intake). The post is classified by the EXISTING qualifyDemand (demand-qualifier.ts) under the play's rubric
//     (demand-rubric-play.ts, the canonical async loader). high_intent alone is NOT verified buying need: the outer
//     binding also requires the post's OWN author (as the source reports it - never the lead's founder read off
//     another page) to belong to the lead's company, the lead itself to be verified, and the company domain to be
//     confirmed NOW (domain-basis.ts, the same rule actionability reads).
//   - hiring_trigger: the request's compiled targeting plan (targeting.ts) supports the HIRING-ONLY classification -
//     an open hiring condition in positive AND scope, unambiguous. A completed hire (hire_made), a negated hiring
//     condition, hiring as one branch of an OR, an unreadable or ambiguous plan is never a buying-need basis, and a
//     trigger-only lead is NEVER labelled verified buying need; the existing sales-hiring gate stands unchanged.
//
// Fail closed everywhere: no rubric (conflicted / offerless / foreign play), a rubric load error, an unknown or
// unbound author, a missing/future/stale date, an unconfirmed or withdrawn domain, a stored record whose bindings
// drifted (offer, window, qualifier version, plan, class/tier on re-read), or a missing record all read as NOT
// proven, with the named reason. Reads never write; a re-read does not re-evaluate or backfill. The writer runs only
// from the scan's own write stage - never from a route, a backfill or a live re-evaluation.
//
// Engine-neutral (Db layer, docs/PLATFORM.md): SQLite and Postgres. SQLite schema here; PG twin:
// lib/db/migrations/pg/0052_lead_need_evidence.sql.
import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import type { Db, Tx, TxBody } from '../db/client.ts'
import { companyKey } from './evidence.ts'
import { compileTargeting, type PlanNode, type QueryPlan } from './targeting.ts'
import { qualifyDemand, DEMAND_QUALIFIER_VERSION, type DemandClass, type DemandPost, type Tier } from './demand-qualifier.ts'
import { loadPlayDemandRubric } from './demand-rubric-play.ts'
import type { ComplaintItem } from '../signals/competitor-reddit.ts'
import { domainConfirmedDb } from '../signals/domain-basis.ts'
import { salesHiringRequired } from './sales-hiring-required.ts'

export const NEED_CONNECTOR = 'scan:need'
export const NEED_TABLE = 'lead_need_evidence'
const TEXT_MAX = 4000 // stored post text: enough to re-run the classifier on re-read, bounded

// ---------------------------------------------------------------------------------------------------- schema
export function migrateNeedEvidence(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lead_need_evidence (
      tenant_id         TEXT NOT NULL,
      job_id            TEXT NOT NULL,
      lead_id           TEXT NOT NULL,
      basis             TEXT NOT NULL CHECK (basis IN ('demand_post', 'hiring_trigger', 'none')),
      verdict           TEXT NOT NULL CHECK (verdict IN ('verified_buying_need', 'needs_evidence', 'trigger_only', 'excluded', 'unqualifiable', 'unproven')),
      reason            TEXT CHECK (reason IS NULL OR length(reason) <= 200),
      qualifier_version TEXT,
      offer             TEXT,
      window_days       INTEGER,
      rubric_reason     TEXT CHECK (rubric_reason IS NULL OR length(rubric_reason) <= 60),
      demand_class      TEXT,
      demand_tier       TEXT,
      scores            TEXT,
      families          TEXT,
      reasons           TEXT,
      missing           TEXT,
      requester         TEXT,
      mentioned_orgs    TEXT,
      source_url        TEXT,
      source_title      TEXT,
      source_text       TEXT,
      author_name       TEXT,
      author_headline   TEXT,
      author_company    TEXT,
      author_url        TEXT,
      published_at      TEXT,
      lead_digest       TEXT,
      plan_support      TEXT NOT NULL,
      created_at        INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, lead_id)
    );
    CREATE INDEX IF NOT EXISTS lead_need_evidence_job ON lead_need_evidence (tenant_id, job_id);
  `)
  try { db.exec('ALTER TABLE lead_need_evidence ADD COLUMN lead_digest TEXT') } catch { /* column already present */ }
  try { db.exec('ALTER TABLE lead_need_evidence ADD COLUMN author_url TEXT') } catch { /* column already present */ }
}

// The lead's own citation triple at write time (source URL, quote, the source's date): a verified record is bound to
// THAT artifact, not merely to the company name. Any later change to the lead's source, excerpt or date - same
// company, same domain - breaks the digest and reads unproven. (reviewer #401/#379: same-artifact binding)
export type ArtifactLead = { source_url: string | null; evidence_excerpt: string | null; published_at: string | null }
export function leadArtifactDigest(lead: ArtifactLead): string {
  return createHash('sha256').update(JSON.stringify([lead.source_url ?? '', lead.evidence_excerpt ?? '', lead.published_at ?? ''])).digest('hex')
}
// Shared pure revalidation (sync gate + async reader): the CURRENT lead row must still cite the exact artifact the
// verdict was recorded from. A record written before the digest existed has no binding: fail closed.
export function revalidateArtifactBinding(rec: { lead_digest: string | null }, lead: ArtifactLead): { ok: true } | { ok: false; reason: string } {
  if (!rec.lead_digest) return { ok: false, reason: 'buying_need_unproven:artifact_digest_missing' }
  if (rec.lead_digest !== leadArtifactDigest(lead)) return { ok: false, reason: 'buying_need_unproven:artifact_changed' }
  return { ok: true }
}

// ---------------------------------------------------------------------------------------------------- plan semantics
// The HIRING-ONLY classification this search's plan supports. "Supported" means the plan states an OPEN hiring
// condition in positive AND scope with no recorded ambiguity. Everything else is named, never silently a pass:
// a completed hire is not an open need; a negated or optional (OR-branch) hiring condition proves nothing about this
// lead's need; an unreadable (root null) or ambiguous plan is unknown, not a bypass.
export type PlanNeedSupport =
  | { support: 'hiring'; conditions: string[] }
  | { support: 'none'; reason: 'no_plan_conditions' | 'plan_ambiguous' | 'hiring_negated' | 'hiring_one_of_choices' | 'completed_hire_not_open_need' | 'no_open_hiring_condition' }

export function planNeedSupport(plan: QueryPlan): PlanNeedSupport {
  if (!plan.root) return { support: 'none', reason: 'no_plan_conditions' }
  if (plan.ambiguities.length > 0) return { support: 'none', reason: 'plan_ambiguous' }
  let positiveHiring: string[] = []
  let negatedHiring = false
  let choiceHiring = false
  let completedHire = false
  const walk = (n: PlanNode, negated: boolean, choice: boolean): void => {
    if (n.op === 'cond') {
      if (n.cond.kind === 'hiring') {
        if (negated) negatedHiring = true
        else if (choice) choiceHiring = true
        else positiveHiring.push(n.cond.id)
      } else if (n.cond.kind === 'hire_made' && !negated) completedHire = true
      return
    }
    if (n.op === 'not') { walk(n.of, !negated, choice); return }
    for (const c of n.of) walk(c, negated, choice || n.op === 'or')
  }
  walk(plan.root, false, false)
  if (positiveHiring.length > 0) return { support: 'hiring', conditions: positiveHiring.sort() }
  if (negatedHiring) return { support: 'none', reason: 'hiring_negated' }
  if (choiceHiring) return { support: 'none', reason: 'hiring_one_of_choices' }
  if (completedHire) return { support: 'none', reason: 'completed_hire_not_open_need' }
  return { support: 'none', reason: 'no_open_hiring_condition' }
}

// ---------------------------------------------------------------------------------------------------- writer
// The registrable domain of a URL or bare host, lowercased: the comparison key for the author's profile-website
// binding. Same second-level-suffix rule as the rubric's own-name resolution (co.uk, com.au move one label more).
const DOMAIN_SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac', 'or', 'ne', 'go', 'gob', 'nom', 'mil'])
export function registrableDomain(v: string | null | undefined): string | null {
  const raw = (v ?? '').trim()
  if (!raw) return null
  try {
    const host = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase().replace(/^www\./, '')
    const parts = host.split('.')
    if (parts.length < 2) return null
    const sld = parts.length >= 3 && parts[parts.length - 1].length === 2 && DOMAIN_SECOND_LEVEL.has(parts[parts.length - 2])
    return parts.slice(-(sld ? 3 : 2)).join('.')
  } catch { return null }
}

// A demand-signal post the search's own intake collected, bound to the lead that cites it by the EXACT source URL.
// author/published_at are the source's own values; null when the source does not carry them (never inferred).
export interface DemandArtifact {
  source_url: string
  author: { name: string | null; headline?: string | null; company?: string | null; url?: string | null } | null
  title?: string | null
  text: string
  published_at: string | null
}
// Intake from the competitor-complaint collector: the post's OWN author exactly as the source reported it (name,
// headline, company), or null when the source does not carry one. NEVER inferred from the lead, the tenant or the
// text - name canonicalization is not authentication, and an authorless post can never verify buying need.
export function complaintDemandArtifact(c: ComplaintItem): DemandArtifact {
  return {
    source_url: c.url,
    author: c.author ? { name: c.author.name, headline: c.author.headline, company: c.author.company, url: c.author.url } : null,
    title: c.title ?? null,
    text: c.quote ?? '',
    published_at: c.date ?? null,
  }
}
export interface RecordNeedInput {
  asOf: Date
  windowDays?: number
  demandArtifacts?: DemandArtifact[]
  held?: ReadonlyMap<string, string> // leads a REQUIRED gate already holds (lead id -> its hold reason)
}
export type NeedVerdict = 'verified_buying_need' | 'needs_evidence' | 'trigger_only' | 'excluded' | 'unqualifiable' | 'unproven'
export interface NeedSummary {
  leads: number
  verified_buying_need: number
  needs_evidence: number
  trigger_only: number
  excluded: number
  unqualifiable: number
  unproven: number
  reasons: Record<string, number>
  rubric: 'ok' | string // 'ok', or the loader's reason the play has no rubric
  plan_support: string // 'hiring' or 'none:<reason>'
}

interface LeadRow { id: string; company: string; company_domain: string | null; source_url: string; evidence_excerpt: string | null; published_at: string | null; review_reason: string | null; confidence: number | null; quarantined_at: number | null }
interface VerdictRow {
  lead: LeadRow
  basis: 'demand_post' | 'hiring_trigger' | 'none'
  verdict: NeedVerdict
  reason: string | null
  demand: { class: DemandClass; tier: Tier; scores: string; families: string; reasons: string; missing: string; requester: string; mentioned_orgs: string } | null
  artifact: DemandArtifact | null
}

const clip = (s: string | null | undefined, n: number): string | null => s == null ? null : s.slice(0, n)

// Records the buying-need verdict of every lead a NEW search stored. Runs at the scan's own write stage (the runner,
// at the actionability pass - after enrichment, when domain evidence is current). Loads the play rubric through the
// canonical ASYNC loader exactly once and awaits it; a play with no rubric is recorded per lead as unqualifiable with
// the loader's reason, never silently passed and never silently dropped. One row per (tenant, lead); a re-run of the
// same stage rewrites the same bindings. The write is one transaction: a failure leaves NO partial verdicts, and a
// lead with no record reads as unproven (currentBuyingNeed), so a failed writer can never leave a verified impression.
export async function recordNeedEvidence(db: Db, tenantId: string, jobId: string, input: RecordNeedInput): Promise<NeedSummary> {
  const job = await db.get<{ query: string | null; icp: string | null }>('SELECT query, icp FROM scan_jobs WHERE id = ? AND user_id = ?', [jobId, tenantId])
  if (!job) throw new Error('need evidence: no such job for this tenant')
  const plan = compileTargeting(job.query, job.icp)
  const support = planNeedSupport(plan)
  const supportKey = JSON.stringify(support)
  const hiringRequired = salesHiringRequired(job.query, job.icp)
  const { rubric, reason: rubricReason } = await loadPlayDemandRubric(db, tenantId, jobId, input.windowDays)
  const artifacts = new Map((input.demandArtifacts ?? []).map(a => [a.source_url, a]))
  const leads = await db.all<LeadRow>(
    `SELECT l.id, l.company, l.company_domain, l.source_url, l.evidence_excerpt, l.published_at, l.review_reason, l.confidence, l.quarantined_at
     FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.scan_job_id = ? AND j.user_id = ? AND l.company <> ''`,
    [jobId, tenantId])

  const rows: VerdictRow[] = []
  for (const lead of leads) {
    const heldReason = input.held?.get(lead.id) ?? null
    const artifact = artifacts.get(lead.source_url) ?? null
    if (artifact) {
      // Demand-post basis: the EXISTING classifier on source-bound fields only. No author is manufactured from the
      // lead's company or founder; the page's own publication day is the post date, never a fresher event date.
      const post: DemandPost = {
        source_url: lead.source_url,
        published_at: artifact.published_at,
        author: artifact.author,
        title: artifact.title ?? null,
        text: (artifact.text ?? '').slice(0, TEXT_MAX),
      }
      const q = qualifyDemand(post, rubric, input.asOf)
      const demand = {
        class: q.class, tier: q.tier,
        scores: JSON.stringify(q.scores), families: JSON.stringify(q.families), reasons: JSON.stringify(q.reasons),
        missing: JSON.stringify(q.missing), requester: JSON.stringify(q.requester), mentioned_orgs: JSON.stringify(q.mentioned_orgs),
      }
      if (!rubric) {
        rows.push({ lead, basis: 'demand_post', verdict: 'unqualifiable', reason: `buying_need_unproven:no_rubric:${rubricReason ?? 'unknown'}`.slice(0, 200), demand, artifact })
        continue
      }
      if (q.tier === 'high_intent') {
        // The outer canonical binding: the post's OWN author belongs to the lead's company, the lead is a verified
        // row, and the company domain is confirmed NOW. high_intent without all three stays needs_evidence.
        const authorName = (q.requester.name ?? '').trim()
        const authorCompany = (q.requester.company ?? '').trim()
        const authorSite = registrableDomain(artifact.author?.url)
        const leadSite = registrableDomain(lead.company_domain)
        const companyBound = !!authorCompany && companyKey(authorCompany) !== '' && companyKey(authorCompany) === companyKey(lead.company)
        // The second supported same-source binding: the author's profile website - reported verbatim in the same
        // platform payload (today only X carries one) - IS the lead's own domain. Never parsed from free text,
        // never inferred; the domain itself must still be confirmed NOW by the lead's own evidence below.
        const websiteBound = !!authorSite && !!leadSite && authorSite === leadSite
        const authorBound = companyBound || websiteBound
        const leadVerified = lead.review_reason === null && lead.confidence !== null && lead.quarantined_at === null && !heldReason
        const domainNow = authorBound && leadVerified && !!lead.company_domain ? await domainConfirmedDb(db, tenantId, lead.id, lead.company_domain) : false
        const ok = authorBound && leadVerified && domainNow
        // The unbound reason names the actual gap (reviewer #401/#379): a source that reports no company for the
        // author (today every worker platform - Reddit reports only a username) can never verify, and company is
        // NEVER inferred from the lead, the post text or the seller profile. Such a lead ends at needs_evidence
        // with the reason saying exactly why, not at a silent dead end.
        const unbound = !authorCompany && !authorSite
          ? authorName ? 'author_company_unavailable_from_source' : 'author_unavailable_from_source'
          : 'author_company_mismatch'
        rows.push({
          lead, basis: 'demand_post', verdict: ok ? 'verified_buying_need' : 'needs_evidence',
          reason: ok ? null : !authorBound ? unbound : !leadVerified ? 'lead_not_verified' : 'domain_unconfirmed_now',
          demand, artifact,
        })
      } else if (q.tier === 'needs_evidence') {
        rows.push({ lead, basis: 'demand_post', verdict: 'needs_evidence', reason: 'needs_evidence', demand, artifact })
      } else if (q.tier === 'weak_trigger') {
        rows.push({ lead, basis: 'demand_post', verdict: 'unproven', reason: `buying_need_unproven:weak_trigger:${q.class}`.slice(0, 200), demand, artifact })
      } else if (q.tier === 'excluded') {
        rows.push({ lead, basis: 'demand_post', verdict: 'excluded', reason: `excluded:${q.class}`.slice(0, 200), demand, artifact })
      } else {
        rows.push({ lead, basis: 'demand_post', verdict: 'unqualifiable', reason: `buying_need_unproven:unqualifiable:${q.missing[0] ?? 'unknown'}`.slice(0, 200), demand, artifact })
      }
      continue
    }
    if (heldReason) {
      // A lead a REQUIRED gate holds has no proven need, whatever the plan supports.
      rows.push({ lead, basis: support.support === 'hiring' ? 'hiring_trigger' : 'none', verdict: 'unproven', reason: `buying_need_unproven:${heldReason}`.slice(0, 200), demand: null, artifact: null })
      continue
    }
    const leadVerified = lead.review_reason === null && lead.confidence !== null && lead.quarantined_at === null
    if (support.support === 'hiring' && hiringRequired && leadVerified) {
      // The trigger gate already ran and this lead still stands. Trigger-only: never "verified buying need".
      rows.push({ lead, basis: 'hiring_trigger', verdict: 'trigger_only', reason: 'trigger_only', demand: null, artifact: null })
    } else {
      const why = support.support === 'none' ? support.reason : !hiringRequired ? 'hiring_not_proven' : 'lead_not_verified'
      rows.push({ lead, basis: support.support === 'hiring' ? 'hiring_trigger' : 'none', verdict: 'unproven', reason: `buying_need_unproven:${why}`.slice(0, 200), demand: null, artifact: null })
    }
  }

  const now = Math.floor(input.asOf.getTime() / 1000)
  await db.tx(function* (t): TxBody<void> {
    for (const r of rows) {
      yield* t.run(
        `INSERT INTO lead_need_evidence (tenant_id, job_id, lead_id, basis, verdict, reason, qualifier_version, offer, window_days, rubric_reason,
           demand_class, demand_tier, scores, families, reasons, missing, requester, mentioned_orgs, source_url, source_title, source_text, author_name, author_headline, author_company, author_url, published_at, lead_digest, plan_support, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, lead_id) DO UPDATE SET job_id = excluded.job_id, basis = excluded.basis, verdict = excluded.verdict, reason = excluded.reason,
           qualifier_version = excluded.qualifier_version, offer = excluded.offer, window_days = excluded.window_days, rubric_reason = excluded.rubric_reason,
           demand_class = excluded.demand_class, demand_tier = excluded.demand_tier, scores = excluded.scores, families = excluded.families,
           reasons = excluded.reasons, missing = excluded.missing, requester = excluded.requester, mentioned_orgs = excluded.mentioned_orgs,
           source_url = excluded.source_url, source_title = excluded.source_title, source_text = excluded.source_text, author_name = excluded.author_name, author_headline = excluded.author_headline, author_company = excluded.author_company, author_url = excluded.author_url,
           published_at = excluded.published_at, lead_digest = excluded.lead_digest, plan_support = excluded.plan_support, created_at = excluded.created_at`,
        [tenantId, jobId, r.lead.id, r.basis, r.verdict, r.reason,
          r.demand ? DEMAND_QUALIFIER_VERSION : null, rubric?.offer ?? null, rubric?.window_days ?? null, rubric ? null : rubricReason,
          r.demand?.class ?? null, r.demand?.tier ?? null, r.demand?.scores ?? null, r.demand?.families ?? null, r.demand?.reasons ?? null,
          r.demand?.missing ?? null, r.demand?.requester ?? null, r.demand?.mentioned_orgs ?? null,
          clip(r.lead.source_url, 500), clip(r.artifact?.title ?? null, 300), r.artifact ? clip(r.artifact.text, TEXT_MAX) : null,
          clip(r.artifact?.author?.name ?? null, 200), clip(r.artifact?.author?.headline ?? null, 300), clip(r.artifact?.author?.company ?? null, 200), clip(r.artifact?.author?.url ?? null, 500), clip(r.artifact?.published_at ?? null, 40),
          leadArtifactDigest(r.lead), supportKey, now])
      // The card row beside the lead (lead_enrichments), same verdict in the existing per-lead channel.
      yield* t.run('DELETE FROM lead_enrichments WHERE lead_id = ? AND tenant_id = ? AND connector = ?', [r.lead.id, tenantId, NEED_CONNECTOR])
      yield* t.run(
        'INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)',
        [`need-${r.lead.id}`, r.lead.id, tenantId, NEED_CONNECTOR, 'buying_need',
          clip(cardText(r), 254)!, clip(JSON.stringify({ verdict: r.verdict, reason: r.reason, class: r.demand?.class ?? null, tier: r.demand?.tier ?? null }), 200),
          /^https?:/.test(r.lead.source_url) ? clip(r.lead.source_url, 500)! : 'https://invalid.example/',
          (r.artifact?.published_at ?? '').slice(0, 10) || new Date(now * 1000).toISOString().slice(0, 10), now])
    }
  })

  const summary: NeedSummary = {
    leads: rows.length, verified_buying_need: 0, needs_evidence: 0, trigger_only: 0, excluded: 0, unqualifiable: 0, unproven: 0,
    reasons: {}, rubric: rubric ? 'ok' : rubricReason ?? 'unknown', plan_support: support.support === 'hiring' ? 'hiring' : `none:${support.reason}`,
  }
  for (const r of rows) {
    summary[r.verdict]++
    if (r.reason) summary.reasons[r.reason] = (summary.reasons[r.reason] ?? 0) + 1
  }
  return summary
}

// Truthful English for the machine reasons a needs_evidence verdict can carry: the card says what is actually
// missing, never a generic gap (reviewer #401/#379).
const NEED_REASON_TEXT: Record<string, string> = {
  author_unavailable_from_source: 'the source does not identify the poster',
  author_company_unavailable_from_source: "the source does not report the poster's company or website",
  author_company_mismatch: "the poster's reported company or website does not match this lead",
  lead_not_verified: 'the lead itself is not a verified row',
  domain_unconfirmed_now: 'the company domain is not confirmed now',
}
function cardText(r: VerdictRow): string {
  switch (r.verdict) {
    case 'verified_buying_need': return 'Verified buying need: a dated post by a decision-maker at this company states the need, source-bound and domain-confirmed'
    case 'needs_evidence': return `Buying need not fully proven: ${r.reason === 'needs_evidence' ? 'the post states a need but evidence is missing' : NEED_REASON_TEXT[r.reason ?? ''] ?? r.reason}`
    case 'trigger_only': return 'Hiring trigger only: the sales-hiring proof stands, but a hiring signal is not verified buying need'
    case 'excluded': return `Not a qualified buyer: ${r.reason}`
    case 'unqualifiable': return 'Buying need cannot be qualified for this play: no effective rubric'
    default: return `Buying need unproven: ${r.reason ?? 'no supported evidence'}`
  }
}

// ---------------------------------------------------------------------------------------------------- reader
export interface NeedRecord {
  tenant_id: string; job_id: string; lead_id: string
  basis: 'demand_post' | 'hiring_trigger' | 'none'
  verdict: NeedVerdict; reason: string | null
  qualifier_version: string | null; offer: string | null; window_days: number | null; rubric_reason: string | null
  demand_class: string | null; demand_tier: string | null
  scores: string | null; families: string | null; reasons: string | null
  missing: string | null; requester: string | null; mentioned_orgs: string | null
  source_url: string | null; source_title: string | null; source_text: string | null
  author_name: string | null; author_headline: string | null; author_company: string | null; author_url: string | null; published_at: string | null
  lead_digest: string | null; plan_support: string; created_at: number
}
export type BuyingNeed =
  | { status: 'verified_buying_need'; record: NeedRecord }
  | { status: 'needs_evidence'; record: NeedRecord }
  | { status: 'trigger_only'; record: NeedRecord }
  | { status: 'excluded'; record: NeedRecord }
  | { status: 'unqualifiable'; record: NeedRecord }
  | { status: 'unproven'; reason: string }

// ---------------------------------------------------------------------------------------------------- shared revalidation (PURE)
// ONE implementation of the binding and qualifier rules, shared by the async reader (currentBuyingNeed) and the sync
// classification gate (actionable.ts): both resolve their inputs on their own engine (domainConfirmedDb vs
// domainConfirmed, awaited rubric vs caller-resolved rubric) and then call THESE functions, so the two paths cannot
// drift apart. Nothing here touches a database.
export type DemandBindingRecord = Pick<NeedRecord, 'qualifier_version' | 'offer' | 'window_days' | 'plan_support' | 'demand_class' | 'demand_tier' | 'source_url' | 'source_title' | 'source_text' | 'author_name' | 'author_headline' | 'author_company' | 'author_url' | 'published_at'>
export interface DemandReadContext { rubric: import('./demand-qualifier.ts').DemandRubric | null; rubricReason: string | null; planSupportKey: string; asOf: Date }

// Context + qualifier revalidation of a demand_post record: the plan semantics still match, a CURRENT rubric exists
// and still has the recorded offer and window, the qualifier version is current, the stored source artifact is
// complete, and the EXISTING classifier re-run on that stored artifact under the CURRENT rubric (as of now) still
// classifies it the same. Any drift is named; nothing is bypassed.
export function revalidateDemandContext(rec: DemandBindingRecord, ctx: DemandReadContext): { ok: true } | { ok: false; reason: string } {
  if (rec.plan_support !== ctx.planSupportKey) return { ok: false, reason: 'buying_need_unproven:stale_plan' }
  if (!ctx.rubric) return { ok: false, reason: `buying_need_unproven:no_rubric:${ctx.rubricReason ?? 'unknown'}` }
  if (rec.qualifier_version !== DEMAND_QUALIFIER_VERSION) return { ok: false, reason: 'buying_need_unproven:stale_version' }
  if (rec.offer !== ctx.rubric.offer) return { ok: false, reason: 'buying_need_unproven:stale_offer' }
  if (rec.window_days !== ctx.rubric.window_days) return { ok: false, reason: 'buying_need_unproven:stale_window' }
  if (!rec.source_url || !rec.source_text) return { ok: false, reason: 'buying_need_unproven:record_incomplete' }
  const q = qualifyDemand({
    source_url: rec.source_url, published_at: rec.published_at,
    author: rec.author_name || rec.author_company || rec.author_url ? { name: rec.author_name, headline: rec.author_headline, company: rec.author_company, url: rec.author_url } : null,
    title: rec.source_title, text: rec.source_text,
  }, ctx.rubric, ctx.asOf)
  if (q.class !== rec.demand_class || q.tier !== rec.demand_tier) return { ok: false, reason: 'buying_need_unproven:qualifier_drift' }
  return { ok: true }
}

// The verified-only OUTER canonical binding: the post's OWN author - as the SAME source artifact reports them, bound
// to the lead by its exact source URL, never the lead's founder read off another page and never the seller profile -
// belongs to the lead's company, and the company domain is confirmed NOW. Name canonicalization is not authority: it
// only compares the source-reported author company to the lead's company; decision-maker authority was scored by the
// classifier from the artifact's own headline at write time and re-scored on re-read (revalidateDemandContext).
export function revalidateVerifiedBinding(rec: DemandBindingRecord, leadCompany: string, leadCompanyDomain: string | null, domainConfirmedNow: boolean): { ok: true } | { ok: false; reason: string } {
  const authorName = (rec.author_name ?? '').trim()
  const authorCompany = (rec.author_company ?? '').trim()
  const authorSite = registrableDomain(rec.author_url)
  const leadSite = registrableDomain(leadCompanyDomain)
  const companyBound = !!authorCompany && companyKey(authorCompany) !== '' && companyKey(authorCompany) === companyKey(leadCompany)
  const websiteBound = !!authorSite && !!leadSite && authorSite === leadSite
  if (!companyBound && !websiteBound) {
    // The same split the writer records (need-evidence.ts recordNeedEvidence): the unavailable-vs-mismatch
    // distinction survives a re-read, so a stored verified row whose binding broke says which way it broke.
    const unbound = !authorCompany && !authorSite
      ? authorName ? 'author_company_unavailable_from_source' : 'author_unavailable_from_source'
      : 'author_company_mismatch'
    return { ok: false, reason: `buying_need_unproven:${unbound}` }
  }
  if (!domainConfirmedNow) return { ok: false, reason: 'buying_need_unproven:domain_withdrawn' }
  return { ok: true }
}

// Shared per-job read context, so a listing loads the rubric and plan once (routes). windowDays must be the job's own
// window (the value the writer ran with) or the binding check would misread a default.
export interface NeedReadContext { rubricOffer: string | null; rubricWindow: number | null; rubricReason: string | null; rubric: import('./demand-qualifier.ts').DemandRubric | null; planSupportKey: string | null }
export async function needReadContext(db: Db, tenantId: string, jobId: string, windowDays?: number): Promise<NeedReadContext> {
  const job = await db.get<{ query: string | null; icp: string | null }>('SELECT query, icp FROM scan_jobs WHERE id = ? AND user_id = ?', [jobId, tenantId])
  if (!job) return { rubricOffer: null, rubricWindow: null, rubricReason: 'no_such_play', rubric: null, planSupportKey: null }
  const { rubric, reason } = await loadPlayDemandRubric(db, tenantId, jobId, windowDays)
  return {
    rubricOffer: rubric?.offer ?? null, rubricWindow: rubric?.window_days ?? null, rubricReason: rubric ? null : reason, rubric,
    planSupportKey: JSON.stringify(planNeedSupport(compileTargeting(job.query, job.icp))),
  }
}

// The lead's CURRENT buying-need status: the stored record, believed only while every binding still holds NOW -
// tenant/job scope, the play's current rubric (same offer, window and qualifier version), the plan's current
// semantics, the classifier's verdict on the STORED source artifact re-run under the CURRENT rubric as of NOW, the
// lead still verified, and (for verified buying need) the company domain still confirmed. Any drift, withdrawal or
// absence reads unproven with the named reason. Read-only: no writes, no re-evaluation persisted, no backfill.
export async function currentBuyingNeed(db: Db, tenantId: string, jobId: string, leadId: string, opts: { asOf?: Date; context?: NeedReadContext; record?: NeedRecord | null } = {}): Promise<BuyingNeed> {
  // opts.record: a pre-read row for this lead (listings read the job's rows once); null means known absent.
  const record = opts.record !== undefined ? opts.record : await db.get<NeedRecord>('SELECT * FROM lead_need_evidence WHERE tenant_id = ? AND lead_id = ?', [tenantId, leadId])
  if (!record) return { status: 'unproven', reason: 'buying_need_unproven:no_record' }
  if (record.job_id !== jobId) return { status: 'unproven', reason: 'buying_need_unproven:scope_mismatch' }
  const ctx = opts.context ?? await needReadContext(db, tenantId, jobId, record.window_days ?? undefined)
  if (ctx.planSupportKey === null) return { status: 'unproven', reason: 'buying_need_unproven:no_such_job' }
  if (record.plan_support !== ctx.planSupportKey) return { status: 'unproven', reason: 'buying_need_unproven:stale_plan' }

  if (record.basis === 'demand_post') {
    // The ONE shared revalidation (sync gate uses the same pure functions): context, bindings, classifier re-run.
    const c = revalidateDemandContext(record, { rubric: ctx.rubric, rubricReason: ctx.rubricReason, planSupportKey: ctx.planSupportKey, asOf: opts.asOf ?? new Date() })
    if (!c.ok) return { status: 'unproven', reason: c.reason }
    if (record.verdict === 'verified_buying_need') {
      const lead = await db.get<{ company: string; company_domain: string | null; review_reason: string | null; confidence: number | null; quarantined_at: number | null; source_url: string | null; evidence_excerpt: string | null; published_at: string | null }>(
        'SELECT company, company_domain, review_reason, confidence, quarantined_at, source_url, evidence_excerpt, published_at FROM leads WHERE id = ? AND scan_job_id = ?', [leadId, jobId])
      if (!lead || lead.review_reason !== null || lead.confidence === null || lead.quarantined_at !== null) return { status: 'unproven', reason: 'buying_need_unproven:lead_withdrawn' }
      // The SAME artifact: the lead's current citation/quote/date must be the ones the verdict was recorded from.
      const art = revalidateArtifactBinding(record, lead)
      if (!art.ok) return { status: 'unproven', reason: art.reason }
      const held = await db.get<{ x: number }>("SELECT 1 AS x FROM lead_enrichments h WHERE h.lead_id = ? AND h.connector = 'scan:gate' AND h.kind = 'gate_failed'", [leadId])
      if (held) return { status: 'unproven', reason: 'buying_need_unproven:lead_held' }
      const b = revalidateVerifiedBinding(record, lead.company, lead.company_domain, !!lead.company_domain && await domainConfirmedDb(db, tenantId, leadId, lead.company_domain))
      if (!b.ok) return { status: 'unproven', reason: b.reason }
    }
    if (record.verdict === 'unproven') return { status: 'unproven', reason: record.reason ?? 'buying_need_unproven' }
    return { status: record.verdict, record } as BuyingNeed
  }

  // hiring_trigger / none: the plan semantics were checked above; a trigger-only verdict also needs the lead to still
  // be a verified, unheld row (a later hold or withdrawal ends the trigger reading too).
  if (record.verdict === 'trigger_only') {
    const lead = await db.get<{ review_reason: string | null; confidence: number | null; quarantined_at: number | null }>(
      'SELECT review_reason, confidence, quarantined_at FROM leads WHERE id = ? AND scan_job_id = ?', [leadId, jobId])
    if (!lead || lead.review_reason !== null || lead.confidence === null || lead.quarantined_at !== null) return { status: 'unproven', reason: 'buying_need_unproven:lead_withdrawn' }
    const held = await db.get<{ x: number }>("SELECT 1 AS x FROM lead_enrichments h WHERE h.lead_id = ? AND h.connector = 'scan:gate' AND h.kind = 'gate_failed'", [leadId])
    if (held) return { status: 'unproven', reason: 'buying_need_unproven:lead_held' }
  }
  if (record.verdict === 'unproven') return { status: 'unproven', reason: record.reason ?? 'buying_need_unproven' }
  return { status: record.verdict, record } as BuyingNeed
}
