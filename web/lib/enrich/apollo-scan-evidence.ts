import type Database from 'better-sqlite3'
import { enrichmentsForLeads } from '../connectors/store.ts'
import { discoverContact, discoverProofHold, discoverSite, type DiscoverStateLead } from '../discover/card.ts'
import { timingOptsFor } from '../outreach/lead-hold.ts'
import { publishedCandidateFor, splitName } from '../people/email-pattern.ts'
import { requiredGateHeld } from '../scan/held-state.ts'
import { eventDayVerified, timingUnconfirmedReason } from '../scan/scoreboard.ts'
import { domainConfirmed } from '../signals/domain-basis.ts'
import type { ApolloBuyerEvidence } from './apollo-ready-match.ts'

type CrawlLead = DiscoverStateLead & {
  id: string
  event_date_proof: string | null
  signal: string | null
  signal_kind: string | null
  source_url: string | null
  confidence: number | null
}

export function collectApolloScanEvidence(
  db: Database.Database,
  tenantId: string,
  scanId: string,
  completedCrawlIds: readonly string[],
  now = new Date(),
): { leadId: string; evidence: ApolloBuyerEvidence }[] {
  const job = db.prepare("SELECT query, icp FROM scan_jobs WHERE id = ? AND user_id = ? AND status = 'done'")
    .get(scanId, tenantId) as { query: string | null; icp: string | null } | undefined
  if (!job) return []
  const timing = timingOptsFor(job)
  const readLead = db.prepare("SELECT * FROM leads WHERE id = ? AND scan_job_id = ? AND source_kind = 'discover'")
  const candidates: { leadId: string; evidence: ApolloBuyerEvidence }[] = []
  // Only IDs delivered by the current worker's completed own-site crawl belong here.
  for (const leadId of new Set(completedCrawlIds)) {
    const lead = readLead.get(leadId, scanId) as CrawlLead | undefined
    if (!lead?.source_url || !lead.signal || lead.confidence == null ||
      !eventDayVerified(lead, { now }) ||
      timingUnconfirmedReason({ ...lead, intent: lead.intent ?? null }, { ...timing, now }) ||
      discoverProofHold({ ...lead, gate_held: !!requiredGateHeld(db, tenantId, leadId) }, now)) continue
    const domain = discoverSite(lead.company_domain)
    if (!domain || !domainConfirmed(db, tenantId, leadId, domain)) continue
    const enrichments = enrichmentsForLeads(db, tenantId, [leadId])[leadId] ?? []
    const buyer = discoverContact({ ...lead, enrichments })?.person
    if (!buyer?.source) continue
    const name = splitName(buyer.name)
    if (!name || enrichments.some(row => row.kind === 'email') ||
      publishedCandidateFor(db, tenantId, leadId, buyer.name)) continue
    candidates.push({ leadId, evidence: { first: name.first, last: name.last, confirmedDomain: domain,
      dayVerified: true, otherwiseReady: true, ownSiteRead: 'none_published' } })
  }
  return candidates
}
