// Test helper for the #401/#379 buying-need promotion gate: seeds a verified buying-need verdict through the REAL
// writer (recordNeedEvidence), so the seeded record always matches the writer's actual contract - bindings, columns
// and all - and this helper throws if the writer would not verify the fixture. Not a bypass: the gate re-runs its
// real checks on the writer's own rows.
import type Database from 'better-sqlite3'
import { demandRubric, type DemandRubric } from '../../lib/scan/demand-qualifier.ts'
import { recordNeedEvidence, migrateNeedEvidence } from '../../lib/scan/need-evidence.ts'
import { sqliteDb } from '../../lib/db/client.ts'

export const NEED_OFFER = 'Dazl finds B2B sales leads and builds verified prospect lists for outbound teams'
// The rubric the canonical loader resolves for a store without a users/competitors table (own names unknown, none saved).
export const NEED_RUBRIC: DemandRubric = demandRubric({ offer: NEED_OFFER, competitors: [], own_names: [], window_days: 90 })!
export const NEED_GATE = { rubric: NEED_RUBRIC }

// A dated first-person post by a decision-maker at `company` stating the need the rubric's offer serves.
export const needPost = "I'm the co-founder of a B2B invoicing startup. We need a reliable source of sales leads for mid-size accounting firms. Any recommendations for a lead list provider?"

// Records a verified buying-need verdict for the lead through the actual writer: the play's offer is stamped on the
// job (as a play's confirmed offer would be), the source artifact is a dated decision-maker post at the company, and
// the writer's own summary must say verified_buying_need or this fixture is wrong.
export async function seedNeedVerified(db: Database.Database, tenantId: string, jobId: string, leadId: string, company: string): Promise<void> {
  migrateNeedEvidence(db)
  db.prepare('UPDATE scan_jobs SET offer = ?, offer_set_at = ? WHERE id = ?').run(NEED_OFFER, Math.floor(Date.now() / 1000), jobId)
  const lead = db.prepare('SELECT source_url FROM leads WHERE id = ?').get(leadId) as { source_url: string } | undefined
  if (!lead) throw new Error(`seedNeedVerified: no lead ${leadId}`)
  const s = await recordNeedEvidence(sqliteDb(db), tenantId, jobId, {
    asOf: new Date(),
    demandArtifacts: [{
      source_url: lead.source_url,
      author: { name: 'Maya Chen', headline: `Co-founder, ${company}`, company },
      title: null, text: needPost, published_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    }],
  })
  if (s.verified_buying_need !== 1) throw new Error(`seedNeedVerified: the writer did not verify ${leadId}: ${JSON.stringify(s.reasons)}`)
}
