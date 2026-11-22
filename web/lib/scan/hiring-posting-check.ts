// #533 / #1205 live (prod 37d46761, job fbaf13da...): a hiring lead must be proven by ONE specific posting of the requested role.
// Pure; no network. Two checks, both generic (page shape and the request's own words; no domain, city, industry or role list):
//  - an aggregate page (a market report, a search / results / browse / category listing, salary or outlook statistics) is not a posting:
//    it names no single opening and dates none, so it never proves a hiring signal;
//  - a posting whose title names none of the requested roles is another vacancy ("treatment coordinator" for "front desk receptionist").
import { matchedHiringRole, roleNeedsSourceProof, type RequestedHiringRole } from './hiring-role-match.ts'

const AGGREGATE_SEGMENT = /^(?:market-?reports?|marketreport|reports?|search|results?|browse|listings?|categor(?:y|ies)|directory|trends?|outlook|salar(?:y|ies)|wages?|statistics|stats|insights?|explore)$/i
const SEARCH_PARAM = /^(?:q|query|keywords?|search|what|term|searchterm|kw)$/i

export function isAggregateJobPage(rawUrl: string): boolean {
  let u: URL
  try { u = new URL(rawUrl) } catch { return false }
  if (u.pathname.split('/').filter(Boolean).some(s => AGGREGATE_SEGMENT.test(decodeURIComponent(s)))) return true
  for (const k of u.searchParams.keys()) if (SEARCH_PARAM.test(k)) return true
  return false
}

const words = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean)
const stem = (w: string) => w.replace(/(?:ies)$/, 'y').replace(/(?<!s)s$/, '')
// A requested role is named when its head noun (the last word: "receptionist" of "front desk receptionist") is in the text. Lenient on
// qualifiers ("dental receptionist" is a receptionist posting), strict on the role itself.
const GENERIC_TAIL = new Set(['role', 'position', 'job', 'opening', 'vacancy', 'staff', 'team', 'people', 'hire', 'worker', 'employee'])
// Qodo #1510 M4: a level noun alone does not name a role ("office manager" is not "sales manager"): the word before it must match too.
const LEVEL = new Set(['manager', 'director', 'coordinator', 'assistant', 'specialist', 'lead', 'officer', 'associate', 'representative', 'executive', 'administrator', 'head', 'supervisor', 'analyst', 'consultant', 'technician', 'engineer', 'clerk', 'agent'])
export function namesRequestedRole(text: string, roles: RequestedHiringRole[]): boolean {
  if (matchedHiringRole(text, roles)) return true // the bounded synonyms (SDR = sales development representative)
  const have = new Set(words(text).map(stem))
  return roles.some(r => {
    const w = words(r.term).map(stem)
    while (w.length > 1 && GENERIC_TAIL.has(w[w.length - 1])) w.pop() // "payroll roles" names payroll
    if (!w.length || !have.has(w[w.length - 1])) return false
    return !(LEVEL.has(w[w.length - 1]) && w.length > 1) || have.has(w[w.length - 2])
  })
}

// A title that names no vacancy: empty, or only words like job / careers / apply / hiring / opportunities (plus a site or company after a separator).
const GENERIC_WORDS = /^(?:jobs?|careers?|career|opportunit(?:y|ies)|employment|apply|apply now|now hiring|we(?:'re| are) hiring|hiring|join us|join our team|work with us|vacanc(?:y|ies)|openings?|positions?|job posting|job details|home)$/i
const genericTitle = (t: string): boolean => { const head = t.split(/\s+[|\u2013\u2014-]\s+|\s*[|:]\s*/)[0].trim().replace(/[^a-z' ]/gi, ' ').replace(/\s+/g, ' ').trim(); return !head || GENERIC_WORDS.test(head) }
// A title naming a vacancy: a level noun (coordinator, manager...) or a word shaped like a job title (-ist, -ian, -ant: hygienist, technician, assistant).
// A company or site name ("Acme Dental") is neither, so its quote is still read.
const vacancyTitle = (t: string): boolean => words(t).map(stem).some(w => LEVEL.has(w) || /(?:ist|ian|ant)$/.test(w) && w.length > 5)
const hiringObjects = (q: string): string[] => [
  ...[...q.matchAll(/\b(?:hiring|recruiting|seeking|needs|wants|looking\s+for|now\s+hiring:?|wanted:?)\s+(?:for\s+)?(?:(?:an?|the|new|our|one|two|several)\s+)*([a-z][a-z /&-]{1,60})/gi)].map(m => m[1].split(/\s+(?:to|who|with|in|at|for|that|and|or)\b/i)[0]),
  // Qodo #1512 H1: a "<role> position" counts only as a heading-like statement opening the quote or a sentence, never a qualification
  // ("prior experience in a front desk receptionist position").
  ...[...q.matchAll(/(?:^|[.!?:]\s+)(?:(?:an?|the|new|open|full[- ]time|part[- ]time)\s+)*([a-z][a-z /&-]{1,40}?)\s+(?:job|position|opening|vacancy)\b(?!\s+(?:required|preferred|experience|background))/gi)]
    .filter(m => !/\b(?:experience|prior|previous|former|past|worked|background)\b/i.test(m[1])).map(m => m[1].split(/\s+/).slice(-4).join(' ')),
]
export type HiringPostingVerdict = { ok: true } | { ok: false; reason: 'posting_not_specific' | 'job_role_mismatch' }
// Qodo #1510 H1: the posting's role is read from the POSTING (the board record's title, else the fetched page's title, with the candidate's
// quote only where it names the role as what is being hired); never from the model-written signal.
// Qodo #1510 M2: in a request mixing sales and other titles, a posting that names none of them is off-role; a sales title stays the sales gate's to prove.
export function hiringPostingVerdict(c: { source_url: string; signal: string | null; excerpt?: string | null }, roles: RequestedHiringRole[], posting?: { boardTitle?: string | null; pageTitle?: string | null }): HiringPostingVerdict {
  if (isAggregateJobPage(c.source_url)) return { ok: false, reason: 'posting_not_specific' }
  const plain = roles.filter(r => !roleNeedsSourceProof(r)), sales = roles.filter(roleNeedsSourceProof)
  if (!plain.length) return { ok: true }
  const names = (t: string) => namesRequestedRole(t, plain) || (sales.length > 0 && namesRequestedRole(t, sales))
  if (posting?.boardTitle) return names(posting.boardTitle) ? { ok: true } : { ok: false, reason: 'job_role_mismatch' }
  if (posting?.pageTitle && names(posting.pageTitle)) return { ok: true }
  // Qodo #1512 H3: a page title naming another vacancy is the posting's role; the quote is read only when the title is generic or absent.
  if (posting?.pageTitle && !genericTitle(posting.pageTitle) && vacancyTitle(posting.pageTitle)) return { ok: false, reason: 'job_role_mismatch' }
  // A generic page title ("Job"): the quote may still state the vacancy, but only as the OBJECT of hiring ("is hiring a payroll specialist",
  // "receptionist position"), never as a role merely mentioned in the description ("reports to the front desk receptionist").
  if (hiringObjects(c.excerpt ?? '').some(names)) return { ok: true }
  return { ok: false, reason: 'job_role_mismatch' }
}
