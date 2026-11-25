import { fallbackIcp, type Icp } from './icp.ts'

// A saved buyer is not approval for a new typed search. Only negative constraints
// and research provenance carry; positive targeting comes from the request itself.
// A reviewed editor or manual-target submission already supplies this play's target.
export function requestTarget(query: string, profile: Icp | null, reviewed: boolean): Icp | null {
  if (reviewed || query.length < 3) return profile
  return {
    ...fallbackIcp(query),
    request: query,
    exclude: profile?.exclude ?? [],
    ...(profile?.carry_exclude ? { carry_exclude: profile.carry_exclude } : {}),
    ...(profile?.research ? { research: profile.research } : {}),
    ...(profile?.lookalike ? { lookalike: { ...profile.lookalike, f: [], exclusionsOnly: true as const } } : {}),
  }
}

export function queryProfileOrigin(input: { icp?: string | null; icpReviewed?: boolean; icpFromQuery?: boolean; icpRetained?: boolean }): number {
  return input.icpRetained === true ? 4 : input.icpReviewed === true ? 0 : input.icpFromQuery === true ? 2 : 3
}
