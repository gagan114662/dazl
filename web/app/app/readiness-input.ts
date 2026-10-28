import type { ReadinessInput } from '@/lib/readiness'

// The tenant reads behind Home's checklists (all existing GET endpoints). A read that fails comes back null, which the
// checklists show as "could not check", never as done or to-do. `jobs` is the raw jobs list for the plays shown beside.
export async function loadReadinessInput(): Promise<{ input: ReadinessInput; jobs: ReadinessInput['jobs'] }> {
  const get = (u: string) => fetch(u).then(r => r.ok ? r.json() : null).catch(() => null)
  const [profile, usage, outreach, jobs, sources, keys, advanced, emails, campaigns] = await Promise.all([get('/api/settings/profile'), get('/api/usage'), get('/api/outreach/settings'), get('/api/scan/jobs'), get('/api/scan/sources'), get('/api/settings/llm-key'), get('/api/settings/advanced'), get('/api/outreach'), get('/api/campaigns')])
  const input: ReadinessInput = { profile, usage, outreach, jobs: jobs?.jobs ?? null, totals: jobs?.totals && typeof jobs.totals.searches === 'number' && typeof jobs.totals.finished === 'number' ? jobs.totals : null, sources, keys: Array.isArray(keys?.keys) ? keys.keys : null, rejection: Array.isArray(keys?.keys) && keys.rejection && typeof keys.rejection === 'object' ? keys.rejection : null, advanced: advanced && Array.isArray(advanced.platforms) ? advanced : null, messages: Array.isArray(emails?.messages) ? emails.messages : null, campaigns: Array.isArray(campaigns?.campaigns) ? campaigns.campaigns : null }
  return { input, jobs: jobs?.jobs ?? null }
}
