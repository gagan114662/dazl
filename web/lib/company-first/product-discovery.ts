// This policy selects a source for an ordinary scan. It supplies no evidence or
// Ready decisions. No client-supplied flag, identity, or funding is consulted.
export function companyFirstDiscoveryEnabled(
  job: Readonly<{ user_id: string; funded_by?: string | null; query?: string | null; csv_domain?: string | null; watch_id?: string | null }>,
  configuredTenant: string | undefined,
): boolean {
  return !!configuredTenant && configuredTenant === job.user_id && job.funded_by === 'user'
    && (job.query?.trim().length ?? 0) >= 3 && !job.csv_domain && !job.watch_id
}

// Normal scan admission writes this marker after price validation. The
// request's budget whitelist never accepts it, and the worker still checks the
// exact rollout tenant and funding at execution.
export function markCompanyFirstBudget(raw: string | null): string {
  return JSON.stringify({ ...(raw ? JSON.parse(raw) : {}), discovery_source: 'company_first_v1' })
}

export function hasCompanyFirstBudget(raw: string | null | undefined): boolean {
  try { return !!raw && JSON.parse(raw)?.discovery_source === 'company_first_v1' } catch { return false }
}

// These instructions only affect candidate discovery. Source URLs and claims
// still have to pass the same direct publisher reads and product verifier.
export const COMPANY_FIRST_SEARCH = [
  'Work company-first. Find organizations in the requested geography and category, before looking at signals.',
  'Locate the official company website for each organization and use its actual name to disambiguate it.',
  'Then find a distinct original page for each company that shows its matching, recent signal and where it took place.',
  'Search distinct query angles and prefer different companies over repeated pages for one company.',
  'Return direct signal permalinks, not directories, homepages without the signal, or search results.',
  'Do not look for people or email addresses in discovery.',
].join(' ')

export const COMPANY_FIRST_EXTRACTION = [
  'This is company-first discovery. Return organizations only: name must be empty and contact null.',
  'Copy a dated event only if the publisher text explicitly dates the exact event; do not use its publication, update, or crawl date.',
  'A model-suggested date is not proof.',
].join(' ')
