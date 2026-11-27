import type { ReadinessInput } from '@/lib/readiness'

// The tenant reads behind Home's checklists (all existing GET endpoints). A read that fails comes back null, which the
// checklists show as "could not check", never as done or to-do. `jobs` is the raw jobs list for the plays shown beside.
// #1876: the panels that refresh on focus read this together, so concurrent callers share one read. Nothing is cached:
// the next refresh after it settles reads again. #1880: a refresh passes its epoch (one per focus or save), so the second
// panel joins the read that epoch already started - 9 requests per refresh - while a later epoch starts a new read and
// never joins the one in flight (which still holds the data from before the save).
type ReadinessRead = { input: ReadinessInput; jobs: ReadinessInput['jobs'] }
let inFlight: { promise: Promise<ReadinessRead>; epoch: number } | null = null

export function loadReadinessInput(opts: { fresh?: number } = {}): Promise<ReadinessRead> {
  if (inFlight && (opts.fresh === undefined || inFlight.epoch === opts.fresh)) return inFlight.promise
  const p = readReadinessInput()
  inFlight = { promise: p, epoch: opts.fresh ?? 0 }
  void p.finally(() => { if (inFlight?.promise === p) inFlight = null })
  return p
}

async function readReadinessInput(): Promise<ReadinessRead> {
  const get = (u: string) => fetch(u).then(r => r.ok ? r.json() : null).catch(() => null)
  const [profile, usage, outreach, jobs, sources, keys, advanced, emails, campaigns] = await Promise.all([get('/api/settings/profile'), get('/api/usage'), get('/api/outreach/settings'), get('/api/scan/jobs'), get('/api/scan/sources'), get('/api/settings/llm-key'), get('/api/settings/advanced'), get('/api/outreach'), get('/api/campaigns')])
  const input: ReadinessInput = { profile, usage, outreach, jobs: jobs?.jobs ?? null, totals: jobs?.totals && typeof jobs.totals.searches === 'number' && typeof jobs.totals.finished === 'number' ? jobs.totals : null, sources, keys: Array.isArray(keys?.keys) ? keys.keys : null, rejection: Array.isArray(keys?.keys) && keys.rejection && typeof keys.rejection === 'object' ? keys.rejection : null, advanced: advanced && Array.isArray(advanced.platforms) ? advanced : null, messages: Array.isArray(emails?.messages) ? emails.messages : null, campaigns: Array.isArray(campaigns?.campaigns) ? campaigns.campaigns : null }
  return { input, jobs: jobs?.jobs ?? null }
}
