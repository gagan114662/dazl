// Test helper for the #401/#379 buying-need promotion gate: seeds a REAL recorded verdict whose whole binding
// chain holds (qualifier version, plan semantics, the rubric passed to classification, the classifier re-run on the
// stored source artifact, the source author's company, the domain confirmed now) - the same chain
// lib/scan/need-evidence.ts writes and lib/scan/actionable.ts revalidates. Not a bypass: the gate re-runs the real
// checks on these rows.
import type Database from 'better-sqlite3'
import { demandRubric, DEMAND_QUALIFIER_VERSION, type DemandRubric } from '../../lib/scan/demand-qualifier.ts'
import { compileTargeting } from '../../lib/scan/targeting.ts'
import { planNeedSupport, migrateNeedEvidence } from '../../lib/scan/need-evidence.ts'

export const NEED_OFFER = 'Dazl finds B2B sales leads and builds verified prospect lists for outbound teams'
export const NEED_RUBRIC: DemandRubric = demandRubric({ offer: NEED_OFFER, competitors: [], own_names: ['Dazl'], window_days: 90 })!
export const NEED_GATE = { rubric: NEED_RUBRIC }

// A dated first-person post by a decision-maker at `company` stating the need the rubric's offer serves.
export const needPost = "I'm the co-founder of a B2B invoicing startup. We need a reliable source of sales leads for mid-size accounting firms. Any recommendations for a lead list provider?"

export function seedNeedVerified(db: Database.Database, tenantId: string, jobId: string, leadId: string, company: string, job?: { query?: string | null; icp?: string | null }): void {
  migrateNeedEvidence(db)
  const support = JSON.stringify(planNeedSupport(compileTargeting(job?.query ?? null, job?.icp ?? null)))
  const now = Math.floor(Date.now() / 1000)
  const published = new Date(Date.now() - 3 * 86_400_000).toISOString()
  db.prepare(
    `INSERT INTO lead_need_evidence (tenant_id, job_id, lead_id, basis, verdict, reason, qualifier_version, offer, window_days, rubric_reason,
       demand_class, demand_tier, source_url, source_title, source_text, author_name, author_headline, author_company, published_at, plan_support, created_at)
     VALUES (?, ?, ?, 'demand_post', 'verified_buying_need', NULL, ?, ?, 90, NULL, 'buyer', 'high_intent', ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(tenantId, jobId, leadId, DEMAND_QUALIFIER_VERSION, NEED_OFFER,
    `https://forum.example.test/t/${leadId}`, needPost, 'Maya Chen', `Co-founder, ${company}`, company, published, support, now)
}
