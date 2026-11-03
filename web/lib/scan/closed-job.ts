import type { Candidate } from './evidence.ts'
import type { Page } from './fetch-page.ts'

// Narrow source-level closure detection, not a claim that a job is active when
// no marker is found. Only job-posting URLs and hiring candidates are eligible.
// No model call. Keep the exact public marker and check time for review provenance.
export interface ClosedJobEvidence { marker: string; checkedAt: number; sourceUrl: string }
export function closedJobEvidence(candidate: Pick<Candidate, 'signal' | 'source_url'>, page: Page): ClosedJobEvidence | null {
  let url: URL
  try { url = new URL(candidate.source_url) } catch { return null }
  const host = url.hostname.toLowerCase()
  const isJob = (host.endsWith('linkedin.com') && url.pathname.startsWith('/jobs/view/')) ||
    (host === 'jobs.lever.co' && url.pathname.split('/').filter(Boolean).length >= 2) ||
    (host === 'jobs.ashbyhq.com' && url.pathname.split('/').filter(Boolean).length >= 2) ||
    (host === 'startup.jobs' && /^\/[a-z0-9]+(?:-[a-z0-9]+)*-\d+\/?$/.test(url.pathname)) ||
    (host === 'job-boards.greenhouse.io' && /\/jobs\/\d+/.test(url.pathname)) ||
    (/^www\.builtin[a-z]*\.com$/.test(host) && url.pathname.startsWith('/job/'))
  if (!isJob || !/\b(hir(?:ing|e)|job|role|position|recruit(?:ing|ment))\b/i.test(candidate.signal)) return null
  // Job title/header and first 2000 visible characters only. A closed position in
  // footer recommendations should not invalidate the main posting.
  const header = page.text.replace(/\s+/g, ' ').slice(0, 2000)
  const match = header.match(/\b(?:no longer accepting applications|this (?:job|position|role) is no longer (?:available|open)|this (?:job|position|role) has (?:closed|expired|been filled)|applications for this (?:job|position|role) are closed)\b/i)
  return match ? { marker: match[0], checkedAt: page.retrievedAt, sourceUrl: candidate.source_url } : null
}
