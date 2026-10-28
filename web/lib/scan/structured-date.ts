// An event date the SOURCE PAGE itself declares as structured data (schema.org JSON-LD): an Event's startDate, a JobPosting's datePosted. This is the one page-derived date that may
// finish an undated candidate, and only under these rules (the window / stale / future gate then judges it exactly like a date the model read from the quote):
//   - the node must be about THIS company (Event: its organizer / name / location names the company; JobPosting: hiringOrganization names it),
//   - the kind must fit what the lead claims (a JobPosting date never dates a funding round; an Event date never dates a hiring claim),
//   - exactly one distinct date across all qualifying nodes (several = a list of items: none is this lead's),
//   - a real calendar day. datePublished / dateModified / dateCreated are publication or update stamps and are never read here (page-timing.ts keeps them as labels only).
import { companyKey, hasPhrase, norm } from './evidence.ts'

export type DateKind = 'Event' | 'JobPosting'
export interface StructuredDate { date: string; kind: DateKind }

const HIRING = /\b(?:hir(?:e|es|ed|ing)|recruit\w*|jobs?|roles?|positions?|vacanc\w+|openings?)\b/i
const EVENTISH = /\b(?:open(?:s|ed|ing)?|launch(?:es|ed|ing)?|webinar|conference|summit|event|expo|workshop|ceremony|grand opening)\b/i

export function kindsFor(claim: string): DateKind[] {
  const k: DateKind[] = []
  if (HIRING.test(claim)) k.push('JobPosting')
  if (EVENTISH.test(claim)) k.push('Event')
  return k
}

const day = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T\s])/.exec(v.trim()); if (!m) return null
  const y = +m[1], mo = +m[2], d = +m[3], t = new Date(Date.UTC(y, mo - 1, d))
  return y >= 2000 && y <= 2100 && t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? t.toISOString().slice(0, 10) : null
}
const namesOf = (v: unknown, out: string[] = [], depth = 0): string[] => {
  if (depth > 3 || v == null) return out
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) for (const x of v.slice(0, 10)) namesOf(x, out, depth + 1)
  else if (typeof v === 'object') { const o = v as Record<string, unknown>; if (typeof o.name === 'string') out.push(o.name) }
  return out
}
function* nodes(v: unknown, depth = 0, budget = { n: 400 }): Generator<Record<string, unknown>> {
  if (depth > 5 || budget.n-- <= 0 || v == null || typeof v !== 'object') return
  if (Array.isArray(v)) { for (const x of v) yield* nodes(x, depth + 1, budget); return }
  const o = v as Record<string, unknown>
  yield o
  for (const k of ['@graph', 'mainEntity', 'mainEntityOfPage', 'itemListElement', 'item']) if (o[k] !== undefined) yield* nodes(o[k], depth + 1, budget)
}
const typesOf = (o: Record<string, unknown>): string[] => (Array.isArray(o['@type']) ? o['@type'] : [o['@type']]).filter((x): x is string => typeof x === 'string')

export function resolveStructuredDate(blocks: string[] | undefined, company: string, claim: string): StructuredDate | null {
  const kinds = kindsFor(claim), key = companyKey(company)
  if (!blocks?.length || kinds.length === 0 || key.length < 2) return null
  const found = new Map<string, StructuredDate>()
  for (const raw of blocks) {
    let j: unknown
    try { j = JSON.parse(raw) } catch { continue }
    for (const o of nodes(j)) {
      const types = typesOf(o)
      if (kinds.includes('JobPosting') && types.includes('JobPosting')) {
        const d = day(o.datePosted)
        if (d && namesOf(o.hiringOrganization).some(n => hasPhrase(norm(n), key))) found.set(`JobPosting|${d}`, { date: d, kind: 'JobPosting' })
      }
      if (kinds.includes('Event') && types.some(t => /Event$/.test(t))) {
        const d = day(o.startDate)
        if (d && [...namesOf(o.organizer), ...namesOf(o.name), ...namesOf(o.location), ...namesOf(o.performer)].some(n => hasPhrase(norm(n), key))) found.set(`Event|${d}`, { date: d, kind: 'Event' })
      }
    }
  }
  const dates = new Set([...found.values()].map(f => f.date))
  return dates.size === 1 ? [...found.values()][0] : null   // two different dates = a list of items: none is this lead's
}

// Bounded finishing pass for undated candidates: at most `max` of them, one fetch each (the verifier's cached page, so normally none). Mutates the candidate: event_date and a timing_note
// that says where the date came from. It decides nothing about the window - the caller's window gate judges the new date like any other.
export async function finishUndatedLeads<T extends { company: string; signal: string; excerpt: string; source_url: string; event_date: string | null; timing_note?: string | null }>(
  leads: T[], fetchPage: (url: string) => Promise<{ structured?: string[] } | { fail: string } | null>, max = 6,
): Promise<{ company: string; date: string; kind: DateKind; url: string }[]> {
  const done: { company: string; date: string; kind: DateKind; url: string }[] = []
  let tried = 0
  for (const l of leads) {
    if (l.event_date || tried >= max) continue
    tried++
    let page: Awaited<ReturnType<typeof fetchPage>> = null
    try { page = await fetchPage(l.source_url) } catch { page = null }
    if (!page || 'fail' in page) continue
    const r = resolveStructuredDate(page.structured, l.company, `${l.signal} ${l.excerpt}`)
    if (!r) continue
    l.event_date = r.date
    l.timing_note = `event date ${r.date} read from the page's own structured data (schema.org ${r.kind}), not from the quote`
    done.push({ company: l.company, date: r.date, kind: r.kind, url: l.source_url })
  }
  return done
}
