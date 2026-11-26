import type { Db } from '../db/client.ts'
import { discoverContact, discoverProofHold, discoverSite, type DiscoverStateLead } from '../discover/card.ts'
import { timingOptsFor } from '../outreach/lead-hold.ts'
import { selectPublishedCandidate, splitName, type PublishedCandidateRow } from '../people/email-pattern.ts'
import { requiredGateHeldForJob } from '../scan/held-state.ts'
import { eventDayVerified, timingUnconfirmedReason } from '../scan/scoreboard.ts'
import { domainConfirmedDb } from '../signals/domain-basis.ts'
import type { ApolloBuyerEvidence } from './apollo-ready-match.ts'

type CrawlLead = DiscoverStateLead & {
  id: string
  event_date_proof: string | null
  signal: string | null
  signal_kind: string | null
  source_url: string | null
  confidence: number | null
}

export async function collectApolloScanEvidence(
  db: Db,
  tenantId: string,
  scanId: string,
  completedCrawlIds: readonly string[],
  now = new Date(),
): Promise<{ leadId: string; evidence: ApolloBuyerEvidence }[]> {
  const job = await db.get<{ query: string | null; icp: string | null }>(
    "SELECT query, icp FROM scan_jobs WHERE id = ? AND user_id = ? AND status = 'done'", [scanId, tenantId])
  if (!job) return []
  const timing = timingOptsFor(job)
  const held = await requiredGateHeldForJob(db, tenantId, scanId)
  const candidates: { leadId: string; evidence: ApolloBuyerEvidence }[] = []
  // Only IDs delivered by the current worker's completed own-site crawl belong here.
  for (const leadId of new Set(completedCrawlIds)) {
    const lead = await db.get<CrawlLead>(
      "SELECT * FROM leads WHERE id = ? AND scan_job_id = ? AND source_kind = 'discover'", [leadId, scanId])
    if (!lead?.source_url || !lead.signal || lead.confidence == null ||
      !eventDayVerified(lead, { now }) ||
      timingUnconfirmedReason({ ...lead, intent: lead.intent ?? null }, { ...timing, now }) ||
      discoverProofHold({ ...lead, gate_held: held.has(leadId) }, now)) continue
    const domain = discoverSite(lead.company_domain)
    if (!domain || !await domainConfirmedDb(db, tenantId, leadId, domain)) continue
    const enrichments = await db.all<NonNullable<DiscoverStateLead['enrichments']>[number]>(
      "SELECT connector, kind, value, source_url FROM lead_enrichments WHERE tenant_id = ? AND lead_id = ? AND kind IN ('person', 'email', 'linkedin')",
      [tenantId, leadId])
    const buyer = discoverContact({ ...lead, enrichments })?.person
    if (!buyer?.source) continue
    const name = splitName(buyer.name)
    if (!name || enrichments.some(row => row.kind === 'email')) continue
    const published = await db.all<PublishedCandidateRow>(
      "SELECT person, address, source_url FROM email_candidates WHERE tenant_id = ? AND lead_id = ? AND tier = 'published' AND source_url IS NOT NULL ORDER BY address",
      [tenantId, leadId])
    if (selectPublishedCandidate(published, buyer.name)) continue
    candidates.push({ leadId, evidence: { first: name.first, last: name.last, confirmedDomain: domain,
      dayVerified: true, otherwiseReady: true, ownSiteRead: 'none_published' } })
  }
  return candidates
}
