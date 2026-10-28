// What an extraction that returned nothing was actually given, in counts only (no page text, no URLs, no model output), for the run report
// and the leads page. It states facts: results found, pages asked for, pages actually read, pages that failed, items handed to the model,
// and that it returned N candidates. It never claims the pages "contained no matching company": all that is known is that extraction
// returned none.
import { isJobPage } from '../search/page-class.ts'

export type ExtractionReason = 'reply_unusable' | 'returned_zero'
export interface ExtractionNote {
  results: number          // unique search-result URLs
  requested: number        // pages dazl asked TinyFish to fetch
  fetched: number          // pages that came back with text
  fetch_failed: number     // requested - fetched (a failed provider call counts every requested page)
  fetch_error: boolean     // the fetch call itself failed
  offered: number          // items given to the extraction step (fetched pages + search snippets)
  snippet_only: number     // offered items with no page text
  job_pages_fetched: number // fetched pages that are job postings (by host / path)
  reply: 'usable' | 'unusable'
  returned: number | null  // candidates the extraction step returned; null = its reply could not be read
  reason: ExtractionReason | null
}

export function extractionNote(args: { results: number; requested: number; fetchedUrls: string[]; fetchError: boolean; items: { url: string }[]; parsed: unknown[] | null }): ExtractionNote {
  const fetched = args.fetchedUrls.length
  const returned = args.parsed ? args.parsed.length : null
  return {
    results: args.results, requested: args.requested, fetched, fetch_failed: Math.max(0, args.requested - fetched), fetch_error: args.fetchError,
    offered: args.items.length, snippet_only: Math.max(0, args.items.length - fetched), job_pages_fetched: args.fetchedUrls.filter(isJobPage).length,
    reply: args.parsed === null ? 'unusable' : 'usable', returned,
    reason: args.parsed === null ? 'reply_unusable' : args.parsed.length === 0 ? 'returned_zero' : null,
  }
}

const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`
// Plain-language sentence for the leads page; null when extraction returned candidates or nothing was recorded.
export function emptyExtractionReason(x: ExtractionNote | null | undefined): string | null {
  if (!x || !x.reason) return null
  const read = x.fetch_error ? `dazl asked to read ${n(x.requested, 'page')}, but the page-reading call failed, so none were read`
    : `dazl asked to read ${n(x.requested, 'page')} and read ${x.fetched}${x.fetch_failed ? ` (${n(x.fetch_failed, 'page')} could not be read)` : ''}`
  const given = `The extraction step was given ${n(x.offered, 'item')}${x.offered ? ` (${x.fetched} page text${x.fetched === 1 ? '' : 's'}, ${n(x.snippet_only, 'search snippet')})` : ''}`
  if (x.reason === 'reply_unusable') return `The search returned ${n(x.results, 'result')}; ${read}. ${given}, but its answer could not be read, so nothing was extracted. This says nothing about whether matching companies exist. Try again.`
  const jobs = x.fetched > 0 && x.job_pages_fetched === x.fetched ? ` Every page read was a job posting.` : x.job_pages_fetched > 0 ? ` ${x.job_pages_fetched} of the ${x.fetched} pages read were job postings.` : ''
  return `The search returned ${n(x.results, 'result')}; ${read}. ${given} and returned 0 candidates.${jobs} That is what is known: it does not show that no matching companies exist. Try rewording the request or widening the place or window.`
}
