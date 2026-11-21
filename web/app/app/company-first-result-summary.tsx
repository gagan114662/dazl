import type { CompanyFirstResultCounts } from '@/lib/scan/company-first-results'

export function CompanyFirstResultSummary({ counts }: { counts: CompanyFirstResultCounts }) {
  return <p className="text-xs text-[var(--ink-2)] mb-3 flex flex-wrap items-center gap-1.5" data-testid="company-first-results">
    <span className="tag">{counts.candidates ?? 'Unknown'} candidates</span>
    <span className="tag">{counts.reviewable} leads to review</span>
    <span className="tag">{counts.held} held by checks</span>
    <span className="tag">{counts.dropped ?? 'Unknown'} dropped</span>
  </p>
}
