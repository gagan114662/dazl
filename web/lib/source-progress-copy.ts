// Words for the live per-source progress the status route serves (lib/scan/progress.ts). Display only: every count is
// shown as recorded, and a count that is not known yet (null) reads as "-", never as 0.
import type { SourceProgress } from './scan/progress.ts'

const NAMES: Record<string, string> = {
  'search:tinyfish': 'Web search', 'search:news': 'News articles', 'search:anthropic': 'Web research with your AI key', 'search:openai': 'Web research with your AI key',
  'adapter:jobboards': 'Job postings', 'adapter:github': 'GitHub', 'adapter:youtube': 'YouTube', 'adapter:v2ex': 'V2EX', 'adapter:rss': 'Feeds', 'adapter:pages': 'Web pages',
  'adapter:reddit': 'Reddit', 'adapter:x': 'X posts', 'adapter:linkedin': 'LinkedIn', 'adapter:facebook': 'Facebook',
}
export function sourceName(source: string): string {
  if (NAMES[source]) return NAMES[source]
  const bare = source.replace(/^[a-z]+:/, '').replace(/[_-]+/g, ' ')
  return bare ? bare[0].toUpperCase() + bare.slice(1) : source
}

// The state word on the right of a row.
export function stateText(p: SourceProgress): string {
  if (p.state === 'queued') return 'Waiting'
  if (p.state === 'running') return 'Searching...'
  if (p.state === 'failed') return 'Failed'
  switch (p.status) {
    case 'empty': return 'No results'
    case 'skipped': return 'Not used for this search'
    case 'unavailable': return 'Nothing usable'
    case 'partial': return 'Partly answered'
    case 'no_candidates': return 'Read, none extracted'
    default: return 'Done'
  }
}

const n = (v: number | null) => (v === null ? '-' : String(v))
// "4 found · 2 checked · 1 to review · 1 rejected", once a source has reported how many it found; before that (or for a
// source that found nothing / was not used) no counts line is shown rather than a row of unknowns.
export function countsText(p: SourceProgress): string | null {
  if (p.candidates === null || p.state === 'queued' || p.status === 'skipped' || p.status === 'empty') return null
  if (p.candidates === 0 && p.status !== 'partial') return null
  return `${n(p.candidates)} found · ${n(p.accepted)} checked · ${n(p.review)} to review · ${n(p.rejected)} rejected`
}
