import type { ReactNode } from 'react'
import InfoTip from './ui/info-tip'

// A long caveat, shortened: one plain sentence always visible, and the full original wording behind an (i) tooltip
// (hover, focus or tap; the text stays in the page). The sentence only condenses what the full text says; the full text
// keeps every claim, so nothing a caveat discloses is removed - only moved.
export default function Caveat({ summary, children, className = '' }: { summary: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={className} data-testid="caveat">
      <p>{summary}<InfoTip>{children}</InfoTip></p>
    </div>
  )
}
