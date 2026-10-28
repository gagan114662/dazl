import type { ReactNode } from 'react'

// A long caveat, shortened: one plain sentence always visible, and the full original wording one click away under
// "Details" (closed by default, still in the page). The sentence only condenses what the full text says; the full text
// keeps every claim, so nothing a caveat discloses is removed - only moved.
export default function Caveat({ summary, children, className = '' }: { summary: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={className} data-testid="caveat">
      <p>{summary}</p>
      <details className="mt-1">
        <summary className="cursor-pointer underline text-xs w-fit">Details</summary>
        <p className="mt-1">{children}</p>
      </details>
    </div>
  )
}
