// Deterministic search queries for the hiring signal. No model call and no company list: a hiring request gets queries
// restricted to the public applicant-tracking hosts that serve open postings, with the role words and the place.
// Lever shares the second query: its public JSON carries createdAt, which the board adapter uses as the posting date.
const HIRING = /\b(hiring|hire[sd]?|jobs?|roles?|openings?|positions?|recruit\w*|vacanc\w+)\b/i
const NOISE = new Set(['find', 'finds', 'looking', 'look', 'for', 'with', 'that', 'the', 'and', 'who', 'from', 'have', 'has', 'their', 'they', 'are', 'was', 'were', 'recently', 'recent', 'just', 'newly', 'new', 'posted', 'post', 'posts', 'posting', 'postings', 'companies', 'company', 'people', 'person', 'employees', 'employee', 'staff', 'hiring', 'hire', 'hired', 'hires', 'job', 'jobs', 'role', 'roles', 'open', 'opening', 'openings', 'position', 'positions', 'team', 'remote', 'small', 'mid', 'size', 'sized', 'business', 'businesses', 'smbs', 'smb', 'any', 'all', 'some', 'near', 'based', 'into', 'about', 'also', 'more', 'than', 'least', 'between', 'over', 'under', 'this', 'last', 'week', 'weeks', 'month', 'months', 'days', 'day', 'year', 'years', 'signal', 'signals', 'buying', 'intent', 'one', 'two', 'three', 'ten', 'hundred', 'to', 'or', 'a', 'an', 'of', 'in', 'at', 'on', 'is', 'be', 'by', 'as', 'it', 'its', 'we', 'us', 'our', 'up', 'do', 'if', 'no', 'not'])
const ONE_HOSTS = ['(site:boards.greenhouse.io OR site:job-boards.greenhouse.io)', '(site:jobs.ashbyhq.com OR site:jobs.lever.co)']
export function roleWords(request: string, signals: string[], where: string[]): string[] {
  const places = new Set(where.flatMap(w => w.toLowerCase().split(/[^a-z0-9]+/)).filter(Boolean))
  const seen = new Set<string>(); const out: string[] = []
  for (const w of `${request} ${signals.join(' ')}`.toLowerCase().split(/[^a-z0-9+#]+/)) {
    if (w.length < 2 || /^\d+$/.test(w) || NOISE.has(w) || places.has(w) || seen.has(w)) continue
    seen.add(w); out.push(w); if (out.length === 4) break
  }
  return out
}
export function directQueries(request: string, signals: string[], where: string[]): string[] {
  if (!HIRING.test(`${request} ${signals.join(' ')}`)) return []
  const place = where.map(w => w.replace(/[\u0000-\u001f"()]/g, ' ').replace(/\s+/g, ' ').trim()).find(w => w.length >= 2 && w.length <= 60)
  const roles = roleWords(request, signals, where)
  if (!place || roles.length === 0) return [] // never every state, never every role
  const group = roles.length === 1 ? roles[0] : `(${roles.join(' OR ')})`
  return ONE_HOSTS.map(h => `${h} ${group} ${place}`)
}
