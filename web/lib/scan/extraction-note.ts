// Why extraction produced nothing, in counts only (no page text, no URLs, no model output), for the run report and the leads page.
// A scan whose searches and fetches all worked but whose extraction returned 0 candidates is neither "failed" nor "no results":
// the user is told what dazl actually read.
import { isJobPage } from '../search/page-class.ts'

export type ExtractionReason = 'reply_unusable' | 'only_job_pages' | 'no_match_in_pages' | 'no_pages_read'
export interface ExtractionNote { offered: number; with_page_text: number; job_pages: number; reply: 'usable' | 'unusable'; candidates: number | null; reason: ExtractionReason | null }

export function extractionNote(items: { url: string }[], withPageText: number, parsed: unknown[] | null): ExtractionNote {
  const offered = items.length, jobPages = items.filter(i => isJobPage(i.url)).length
  const candidates = parsed ? parsed.length : null
  let reason: ExtractionReason | null = null
  if (parsed === null) reason = 'reply_unusable'
  else if (parsed.length === 0) reason = withPageText === 0 ? 'no_pages_read' : offered > 0 && jobPages === offered ? 'only_job_pages' : 'no_match_in_pages'
  return { offered, with_page_text: withPageText, job_pages: jobPages, reply: parsed === null ? 'unusable' : 'usable', candidates, reason }
}

// Plain-language sentence for the leads page; null when extraction did produce candidates or nothing was recorded.
export function emptyExtractionReason(n: ExtractionNote | null | undefined): string | null {
  if (!n || !n.reason) return null
  const pages = `${n.with_page_text} page${n.with_page_text === 1 ? '' : 's'}`
  switch (n.reason) {
    case 'reply_unusable': return 'The search found pages, but the model’s answer could not be read, so nothing was extracted. Nothing was concluded about whether matching companies exist. Try again.'
    case 'no_pages_read': return `The search found ${n.offered} result${n.offered === 1 ? '' : 's'}, but no page text could be read (only search snippets), and none named a matching company.`
    case 'only_job_pages': return `dazl read ${pages}, and every one was a job posting; none described a company that matches the request (for example one that also shows the funding or event you asked for). Try wording the request around the event, or widen the place or window.`
    default: return `dazl read ${pages}${n.job_pages ? ` (${n.job_pages} of the ${n.offered} results were job postings)` : ''}, and none described a company that matches the request.`
  }
}
