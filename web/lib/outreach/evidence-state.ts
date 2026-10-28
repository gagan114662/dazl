// The one definition of a lead's evidence state, shared by the send/draft gates (service.ts), the lead card and the
// Campaigns view. Client-safe: pure, no imports.
//   machine    - dazl found the quoted text on the cited page: an excerpt is stored AND a confidence was recorded
//   human      - the user confirmed the lead themselves (never rewrites the machine verdict)
//   unverified - anything else (for example a legacy row with a confidence but no stored excerpt)
export type EvidenceState = 'machine' | 'human' | 'unverified'
export function evidenceStateOf(l: { evidence_excerpt: string | null; confidence: number | null; human_confirmed_at: number | null }): EvidenceState {
  if (l.evidence_excerpt && l.confidence !== null) return 'machine'
  if (l.human_confirmed_at !== null) return 'human'
  return 'unverified'
}
