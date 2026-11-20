// Unmounted contract. Nothing here runs the product gates or writes receipts.
// The sole reader must be a server-owned private store, never a request body,
// route response, legacy run_report, or new finder-produced verdict. It must
// read current job authorization, settlement, candidate and attestations in
// ONE consistent snapshot. An eventual writer must fence the same revisions.
import { createHash } from 'node:crypto'

export const STRICT_GATE_STAGE = Object.freeze({
  // Product rule owners: evidence verifier, feedback, grader, sales hiring,
  // targeting/buying-need/actionable, timing, and current site/contact.
  source_identity_quote_date: 'evidence.verifyEvidence',
  reviewed_target_fit_and_grading: 'score.applyIcpGate+buyer-fit',
  quarantine_exclusions_rejected_people: 'feedback+memory+actionable',
  required_sales_hiring: 'held-state.requiredGateHeld',
  compound_targeting: 'actionable.classifyLeads/targeting',
  current_buying_need: 'actionable.needProven',
  current_timing_and_window: 'timing-proof+currentness+window',
  current_owned_buyer_and_route: 'actionable.currentSiteContact',
  exact_named_published_work_email: 'work-email.strictPublishedWorkEmailsForLeads',
} as const)
type Gate = keyof typeof STRICT_GATE_STAGE
export type Claim = Readonly<{ tenant: string; job: string; attempt: number; actor: string }>
export type CandidateKey = Readonly<{ id: string; revision: string }>
export type CandidateEvidence = Readonly<{
  companyKey: string; website: string; identitySource: string; event: string; eventSource: string
  eventDate: string; literalQuote: string; buyer: string; title: string; buyerBio: string
  linkedin: string; email: string; emailSource: string
}>
type EvidenceField = keyof CandidateEvidence
const evidenceFields = ['companyKey', 'website', 'identitySource', 'event', 'eventSource', 'eventDate', 'literalQuote',
  'buyer', 'title', 'buyerBio', 'linkedin', 'email', 'emailSource'] as const satisfies readonly EvidenceField[]

// The stages own the current-input versions, including authoritative policy,
// feedback, timing and proof changes. An unchanged applicant hash is not a
// substitute for these versions. No generic "not applicable" pass is accepted:
// a conditional rule must have evaluated this context and affirmatively passed.
export type StageAttestation = {
  [K in Gate]: Readonly<{ gate: K; stage: (typeof STRICT_GATE_STAGE)[K]; binding: string;
    inputRevision: string; checkedAt: number; expiresAt: number; decision: 'passed' | 'held' }>
}[Gate]
export type ProofSnapshot = Readonly<{
  claim: Claim
  authorization: 'current' | 'not_current'
  // Not merely "done": the store must verify terminal successful processing,
  // every potentially charged job reservation, and matching trial settlement
  // where applicable. A missing/unreadable ledger is not settled.
  phase: 'finalized' | 'running' | 'interrupted'
  settlement: Readonly<{ attempt: number; state: 'all_charges_resolved' | 'unresolved'; revision: string }>
  policyRevision: string
  candidate: Readonly<{ key: CandidateKey; evidence: CandidateEvidence }>
  currentInputs: Readonly<Record<Gate, string>>
  attestations: readonly StageAttestation[]
}>
export interface PrivateCandidateProofStore {
  readCurrentSnapshot(claim: Claim, candidateId: string): Promise<ProofSnapshot | null>
}

const eqClaim = (a: Claim, b: Claim) => a.tenant === b.tenant && a.job === b.job && a.actor === b.actor && a.attempt === b.attempt
const nonempty = (s: unknown): s is string => typeof s === 'string' && s.trim().length > 0
const gates = Object.keys(STRICT_GATE_STAGE) as Gate[]
export function proofBinding(claim: Claim, key: CandidateKey, policy: string, evidence: CandidateEvidence): string {
  return createHash('sha256').update(JSON.stringify(['company-first-proof:v1', claim.tenant, claim.job, claim.attempt, claim.actor,
    key.id, key.revision, policy, ...evidenceFields.map(f => evidence[f])])).digest('hex')
}

// Identifier only: never expose this, its digest, or private evidence to UI.
// It is a result for this snapshot, NOT a reusable authorization to publish or
// send. A future committing adapter must recheck revisions atomically.
type VerifiedPrivateProof = Readonly<{
  candidateId: string; candidateRevision: string; binding: string; settlementRevision: string; checkedAt: number
}>
const MAX_AGE_MS = 10 * 60_000
export async function evaluatePrivateCandidateProof(store: PrivateCandidateProofStore, claim: Claim, key: CandidateKey,
  expected: CandidateEvidence, clock: () => number = Date.now): Promise<VerifiedPrivateProof | null> {
  if (![claim.tenant, claim.job, claim.actor, key.id, key.revision].every(nonempty) ||
      !Number.isSafeInteger(claim.attempt) || claim.attempt < 1) return null
  // Freeze expected bytes before awaiting the store so retries/mutation cannot
  // replace either the caller claim or evidence in flight.
  const request = Object.freeze({ ...claim })
  const selected = Object.freeze({ ...key })
  const evidence = Object.freeze({ ...expected })
  if (!evidenceFields.every(f => nonempty(evidence[f]))) return null
  try {
    const row = await store.readCurrentSnapshot(request, selected.id)
    const nowMs = clock()
    if (!Number.isSafeInteger(nowMs) || nowMs < 1 || !row || row.authorization !== 'current' || !eqClaim(row.claim, request) || row.phase !== 'finalized' ||
        row.settlement.attempt !== request.attempt || row.settlement.state !== 'all_charges_resolved' || !nonempty(row.settlement.revision) ||
        !nonempty(row.policyRevision) || row.candidate.key.id !== selected.id || row.candidate.key.revision !== selected.revision ||
        !evidenceFields.every(f => row.candidate.evidence[f] === evidence[f])) return null
    const binding = proofBinding(request, selected, row.policyRevision, evidence)
    if (row.attestations.length !== gates.length) return null
    const seen = new Set<Gate>()
    for (const a of row.attestations) {
      if (!Object.hasOwn(STRICT_GATE_STAGE, a.gate) || seen.has(a.gate) || a.stage !== STRICT_GATE_STAGE[a.gate] ||
          a.binding !== binding || !nonempty(row.currentInputs[a.gate]) || a.inputRevision !== row.currentInputs[a.gate] ||
          a.decision !== 'passed' || !Number.isSafeInteger(a.checkedAt) || !Number.isSafeInteger(a.expiresAt) ||
          a.checkedAt <= 0 || a.checkedAt > nowMs || nowMs - a.checkedAt >= MAX_AGE_MS || a.expiresAt <= nowMs) return null
      seen.add(a.gate)
    }
    return Object.freeze({ candidateId: selected.id, candidateRevision: selected.revision, binding, settlementRevision: row.settlement.revision, checkedAt: nowMs })
  } catch { return null }
}
