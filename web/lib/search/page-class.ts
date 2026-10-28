// Which kind of page a search result is, for ordering the scarce fetch slots (16 of ~80 results). Pure; no network.
// A request that needs an event BEYOND hiring (seed funding, an opening, an expansion) cannot be satisfied by a job posting alone:
// the posting only corroborates the hiring half. Large companies' postings on ATS boards are dated and in-window, so ordering by
// date alone fills every slot with them while the (often undated) news and company pages that carry the event are never read.

const JOB_HOST = /^(?:(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io|jobs\.(?:ashbyhq\.com|lever\.co|smartrecruiters\.com|workable\.com)|apply\.workable\.com|[a-z0-9-]+\.bamboohr\.com|[a-z0-9-]+\.recruitee\.com|[a-z0-9-]+\.breezy\.hr|(?:[a-z0-9-]+\.)?(?:indeed|glassdoor|reed|totaljobs|cv-library|monster|ziprecruiter)\.[a-z.]+|wellfound\.com|(?:www\.)?linkedin\.com)$/i
const JOB_PATH = /\/(?:jobs?|careers?|vacanc(?:y|ies)|positions?|openings?|job-?listings?|viewjob|apply)(?:\/|$|\?)/i

export function isJobPage(rawUrl: string): boolean {
  let u: URL
  try { u = new URL(rawUrl) } catch { return false }
  const host = u.hostname.toLowerCase().replace(/^www\./, '')
  if (JOB_HOST.test(host) && (host !== 'linkedin.com' || /\/jobs\//i.test(u.pathname))) return true
  return JOB_PATH.test(u.pathname)
}

// The request asks for a signal that a job posting cannot show on its own.
const EVENT_SIGNAL = /\b(?:fund(?:ing|ed)?|raise[sd]?|raising|seed|pre-?seed|series\s+[a-e]|round|invest(?:ment|ed|or)?|valuation|expan(?:d|ds|ded|sion|ding)|open(?:s|ed|ing)?\s+(?:a\s+|its\s+|new\s+)|new\s+(?:location|office|branch|clinic|store|site)|launch(?:es|ed)?|announce[sd]?|acquir(?:es|ed|ition)|partnership|contract\s+win)\b/i
const HIRING_ONLY = /\b(?:hiring|hire|recruit(?:ing)?|job|jobs|role|roles|position|positions|vacanc(?:y|ies)|opening|openings)\b/gi
export function needsEventBeyondHiring(signals: string[] | undefined, query: string): boolean {
  const text = [...(signals ?? []), query].join(' . ')
  return EVENT_SIGNAL.test(text.replace(HIRING_ONLY, ' '))
}
