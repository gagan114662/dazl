// The lead card's "Research rationale" line (#1201 rule 3 is rendered here: the why text names a model signal used for matching but not
// required). Written without JSX so the node test runner renders this exact component with react-dom/server.
import { createElement as h } from 'react'
export function ResearchRationale({ why }: { why: string | null | undefined }) {
  return why ? h('div', { className: 'text-xs text-gray-300 mt-1' }, 'Research rationale: ', why) : null
}
