import { anthropicProvider } from '../llm/provider.ts'
import { budgetedIcp, fallbackIcp, icpPrompt, keepStatedFundingStage, MAX_QUERY, normalizeIcp, type Icp } from './icp.ts'
import { jsonOnly } from './seller-research.ts'

export type SearchProfile =
  | { source: 'carried'; profile: Icp }
  | { source: 'inferred'; profile: Icp }

function statedPhrase(value: unknown, request: string): string | null {
  if (value === null) return null
  if (typeof value === 'string' && value.trim() && request.includes(value.trim())) return value.trim()
  throw new Error('Search profile constraint was not quoted from the request')
}

export async function resolveSearchProfile(
  query: string,
  saved: Icp,
  apiKey: string,
  fetchImpl?: typeof fetch,
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
Do not carry over saved size, geography, buyer, exclusions, or seller research. Do not infer a country or language
when the replacement has no explicit place. Return only JSON.`
  const reply = jsonOnly(await anthropicProvider.complete!(apiKey, prompt, fetchImpl, 1000)) as Record<string, unknown> | null
  if (reply?.decision === 'keep') return { source: 'carried', profile: saved }
  if (reply?.decision !== 'replace') throw new Error('Search profile decision is missing or invalid')

  const buyer = statedPhrase(reply.buyer, request)
  const place = statedPhrase(reply.place, request)
  const draft = reply.profile
  if ((!buyer && !place) || !draft || typeof draft !== 'object' || Array.isArray(draft)) {
    throw new Error('Replacement search profile is incomplete')
  }
  const { industries, sizes, signals, exclude, country, language } = draft as Record<string, unknown>
  const profile = normalizeIcp({
    summary: fallbackIcp(request).summary,
    who: buyer ? [buyer] : [],
    where: place ? [place] : [],
    industries, sizes, signals, exclude,
    ...(place ? { country, language } : {}),
  })
  if (!profile) throw new Error('Replacement search profile is invalid')
  const bounded = budgetedIcp(keepStatedFundingStage(request, profile))
  if (!bounded.ok) throw new Error('Replacement search profile exceeds its storage budget')
  return { source: 'inferred', profile: bounded.icp }
}
