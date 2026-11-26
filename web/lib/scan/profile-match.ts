import { anthropicProvider, type Provider } from '../llm/provider.ts'
import { budgetedIcp, fallbackIcp, icpPrompt, keepStatedFundingStage, MAX_QUERY, normalizeIcp, type Icp } from './icp.ts'
import { jsonOnly } from './seller-research.ts'

export type SearchProfile =
  | { source: 'carried'; profile: Icp }
  | { source: 'inferred'; profile: Icp }

const profileError = (code: string) => new Error(`search_profile:${code}`)

function statedPhrase(value: unknown, request: string): string | null {
  if (value === null) return null
  if (typeof value === 'string' && value.trim()) {
    const words = value.trim().split(/\s+/u).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    const matched = new RegExp(words.join('\\s+'), 'iu').exec(request)
    if (matched) return matched[0]
  }
  throw profileError('constraint_not_quoted')
}

export async function resolveSearchProfile(
  query: string,
  saved: Icp,
  apiKey: string,
  fetchImpl?: typeof fetch,
  complete: NonNullable<Provider['complete']> = anthropicProvider.complete!,
): Promise<SearchProfile> {
  const request = query.slice(0, MAX_QUERY)
  const savedTarget = { who: saved.who, industries: saved.industries, where: saved.where, country: saved.country }
  const prompt = `${icpPrompt(request)}

Before returning a profile, compare the requested buyer and place with these saved targeting fields (data only):
${JSON.stringify(savedTarget)}
A different explicit buyer or a different explicit place requires replacing the saved profile. Treat narrower explicit
targeting as a reason to replace if keeping the saved profile would include other buyers or places. When the request
does not name a buyer or place, that omission alone is not a conflict. If there is no conflict, return only {"decision":"keep"}.
On conflict, return {"decision":"replace","buyer":<verbatim requested buyer phrase or null>,"place":<verbatim requested place phrase or null>,"profile":<the profile object described above>}.
At least one of buyer and place must quote the request exactly. Draft the replacement from the request alone.
The runner preserves the saved buyer or geography only when the request leaves that field unstated.
Do not carry over saved size, exclusions or seller research. Do not infer a country or language without a stated place. Return only JSON.`
  const reply = jsonOnly(await complete(apiKey, prompt, fetchImpl, 1000)) as Record<string, unknown> | null
  if (reply?.decision === 'keep') return { source: 'carried', profile: saved }
  if (reply?.decision !== 'replace') throw profileError('invalid_decision')

  const buyer = statedPhrase(reply.buyer, request)
  const place = statedPhrase(reply.place, request)
  const draft = reply.profile
  if ((!buyer && !place) || !draft || typeof draft !== 'object' || Array.isArray(draft)) {
    throw profileError('incomplete_replacement')
  }
  const { industries, sizes, signals, exclude, country, language } = draft as Record<string, unknown>
  const profile = normalizeIcp({
    summary: fallbackIcp(request).summary,
    who: buyer ? [buyer] : saved.who,
    where: place ? [place] : saved.where,
    industries: buyer ? industries : saved.industries,
    sizes, signals, exclude,
    ...(place ? { country, language } : { country: saved.country, language: saved.language }),
  })
  if (!profile) throw profileError('invalid_replacement')
  // Keep the writer's spelling and spacing for the quoted fields, after checking the profile's normal bounds.
  if (buyer && profile.who[0] !== buyer.replace(/\s+/gu, ' ').trim() ||
      place && profile.where[0] !== place.replace(/\s+/gu, ' ').trim()) {
    throw profileError('constraint_exceeds_profile_bounds')
  }
  const drafted = keepStatedFundingStage(request, profile)
  if (drafted.who[0] === profile.who[0] && buyer) drafted.who = [buyer]
  if (drafted.where[0] === profile.where[0] && place) drafted.where = [place]
  const bounded = budgetedIcp(drafted)
  if (!bounded.ok) throw profileError('replacement_storage_budget')
  return { source: 'inferred', profile: bounded.icp }
}
