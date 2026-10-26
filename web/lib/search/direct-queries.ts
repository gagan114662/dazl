// Deterministic search queries for the hiring signal. No model call and no company list: a hiring request gets queries
// restricted to the public applicant-tracking hosts that serve open postings, with the role words and the place.
// Lever shares the second query: its public JSON carries createdAt, which the board adapter uses as the posting date.
const HIRING = /\b(hiring|hire[sd]?|jobs?|roles?|openings?|positions?|recruit\w*|vacanc\w+)\b/i
const NOISE = new Set(['find', 'finds', 'looking', 'look', 'for', 'with', 'that', 'the', 'and', 'who', 'from', 'have', 'has', 'their', 'they', 'are', 'was', 'were', 'recently', 'recent', 'just', 'newly', 'new', 'posted', 'post', 'posts', 'posting', 'postings', 'companies', 'company', 'people', 'person', 'employees', 'employee', 'staff', 'hiring', 'hire', 'hired', 'hires', 'job', 'jobs', 'role', 'roles', 'open', 'opening', 'openings', 'position', 'positions', 'team', 'remote', 'small', 'mid', 'size', 'sized', 'business', 'businesses', 'smbs', 'smb', 'any', 'all', 'some', 'near', 'based', 'into', 'about', 'also', 'more', 'than', 'least', 'between', 'over', 'under', 'this', 'last', 'week', 'weeks', 'month', 'months', 'days', 'day', 'year', 'years', 'signal', 'signals', 'buying', 'intent', 'one', 'two', 'three', 'ten', 'hundred', 'to', 'or', 'a', 'an', 'of', 'in', 'at', 'on', 'is', 'be', 'by', 'as', 'it', 'its', 'we', 'us', 'our', 'up', 'do', 'if', 'no', 'not'])
const ONE_HOSTS = ['(site:boards.greenhouse.io OR site:job-boards.greenhouse.io)', '(site:jobs.ashbyhq.com OR site:jobs.lever.co)']
// Role PHRASES, not loose words. "a payroll, HR or office manager job" used to become (payroll OR hr OR office OR manager),
// and the lone word "manager" matched every manager posting in the state. The request is split at list separators
// (comma, slash, "or", "and"); in each part the last run of kept words is one phrase ("office manager"), with "of"/"for"
// allowed inside a run ("head of sales"). Phrases are quoted so the search matches them exactly. The user's own request
// is used first; profile signals only when the request names no role. At most 3 phrases.
const JOINERS = new Set(['of', 'for', '&'])
function phrasesIn(text: string, places: Set<string>): string[] {
  const out: string[] = []
  for (const part of text.toLowerCase().split(/,|;|\/|\bor\b|\band\b/)) {
    const words = part.split(/[^a-z0-9+#&]+/).filter(Boolean)
    let run: string[] = []; let last: string[] = []
    for (const w of words) {
      const keep = w.length >= 2 && !/^\d+$/.test(w) && !NOISE.has(w) && !places.has(w)
      if (keep) run.push(w)
      else if (run.length && JOINERS.has(w)) run.push(w)
      else { while (run.length && JOINERS.has(run[run.length - 1])) run.pop(); if (run.length) last = run; run = [] }
    }
    while (run.length && JOINERS.has(run[run.length - 1])) run.pop()
    if (run.length) last = run
    if (last.length) out.push(last.slice(-3).join(' '))
  }
  return out
}
export function rolePhrases(request: string, signals: string[], where: string[]): string[] {
  const places = new Set(where.flatMap(w => w.toLowerCase().split(/[^a-z0-9]+/)).filter(Boolean))
  const fromRequest = phrasesIn(request, places)
  const all = fromRequest.length ? fromRequest : signals.flatMap(s => phrasesIn(s, places))
  return [...new Set(all)].slice(0, 3)
}
export function directQueries(request: string, signals: string[], where: string[]): string[] {
  if (!HIRING.test(`${request} ${signals.join(' ')}`)) return []
  const place = where.map(w => w.replace(/[\u0000-\u001f"()]/g, ' ').replace(/\s+/g, ' ').trim()).find(w => w.length >= 2 && w.length <= 60)
  const roles = rolePhrases(request, signals, where).map(r => `"${r}"`)
  if (!place || roles.length === 0) return [] // never every state, never every role
  const group = roles.length === 1 ? roles[0] : `(${roles.join(' OR ')})`
  return ONE_HOSTS.map(h => `${h} ${group} ${place}`)
}
