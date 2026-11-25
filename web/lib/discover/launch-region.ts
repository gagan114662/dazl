// Launch coverage is decided from Claude's typed request plan before any web tools are offered.
import type Anthropic from '@anthropic-ai/sdk'
import { completionCost } from '../llm/spend-guard.ts'
import { groundedIn, parsePlan, planPrompt, PLAN_MAX_TOKENS, type PlanPlace } from '../scan/request-plan.ts'
import type { DiscoverInput, DiscoverResult, DiscoverUsage, DiscoveredLead } from './agent.ts'

const PLAN_MODEL = 'claude-haiku-4-5'
const LAUNCH_COUNTRIES = new Set(['US', 'CA'])
const UNSUPPORTED = 'unsupported_search_region'
const UNCONFIRMED = 'search_region_unconfirmed'
const COVERAGE_COPY = 'dazl covers the US and Canada for now. More regions soon.'
const UNCONFIRMED_COPY = 'dazl could not confirm the search location. Try again with a more specific location.'
const ZERO_USAGE: DiscoverUsage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, searches: 0, requests: 0, usd: 0 }

export const LAUNCH_REGION_PROMPT = 'Search only for targets in the US and Canada, including when the request leaves location open. Respect confirmed target locations. Confirm the relevant company or role location from the source before looking for a person or email. Add a "country" field to each returned lead with its ISO 3166-1 alpha-2 code, or null when the source does not establish it.'

type LaunchRegion = { ok: true; places: PlanPlace[]; usage: DiscoverUsage } | { ok: false; result: DiscoverResult }

export async function prepareLaunchRegion(client: Anthropic, input: DiscoverInput, signal?: AbortSignal): Promise<LaunchRegion> {
  const profileLocations = Array.isArray(input.profile?.where)
    ? input.profile.where.slice(0, 8).filter(place => typeof place === 'string').map(place => place.trim().slice(0, 120)).filter(Boolean)
    : []
  const target = JSON.stringify({ query: input.query, profileLocations })
  const reply = await client.messages.create({
    model: PLAN_MODEL,
    max_tokens: PLAN_MAX_TOKENS,
    service_tier: 'standard_only',
    messages: [{
      role: 'user',
      content: `${planPrompt(target)}\nThe request data is a JSON object. Read its query as the user's request, and consider profileLocations only if the query names no target geography. Copy places from the field values. Include every target geography, even a broad one like a continent or worldwide. For those, use null for country. Infer a city or region's country only when confident.`,
    }],
  }, { signal, maxRetries: 0 })
  const usage = {
    input_tokens: reply.usage.input_tokens,
    output_tokens: reply.usage.output_tokens,
    cache_read_tokens: reply.usage.cache_read_input_tokens ?? 0,
    cache_write_tokens: reply.usage.cache_creation_input_tokens ?? 0,
    searches: 0,
    requests: 1,
  }
  const cost = completionCost(reply.model, {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_creation_input_tokens: usage.cache_write_tokens,
    cache_read_input_tokens: usage.cache_read_tokens,
  })
  if ('unknown' in cost) throw new Error('Discovery request plan usage could not be priced')
  const pricedUsage = { ...usage, usd: cost.usd }
  const plan = reply.stop_reason === 'end_turn'
    ? parsePlan(reply.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''))
    : null
  const ground = [input.query, ...profileLocations].join('\n')
  if (!plan || !plan.places.every(place => groundedIn(ground, place))) {
    return { ok: false, result: { leads: [], seen: [], model: reply.model, usage: pricedUsage, stop: UNCONFIRMED, note: UNCONFIRMED_COPY } }
  }
  if (plan.places.some(place => !place.country || !LAUNCH_COUNTRIES.has(place.country))) {
    return { ok: false, result: { leads: [], seen: [], model: reply.model, usage: pricedUsage, stop: UNSUPPORTED, note: COVERAGE_COPY } }
  }
  return { ok: true, places: plan.places, usage: pricedUsage }
}

// The second pass changes the exclusions, not the targets. Charge the plan once within this run.
export function launchRegionForRun(): typeof prepareLaunchRegion {
  let plan: Promise<LaunchRegion> | undefined
  return async (client, input, signal) => {
    if (!plan) return plan = prepareLaunchRegion(client, input, signal)
    const cached = await plan
    return cached.ok ? { ...cached, usage: ZERO_USAGE } : { ...cached, result: { ...cached.result, usage: ZERO_USAGE } }
  }
}

export const isLaunchRegionStop = (stop: string): boolean => stop === UNSUPPORTED || stop === UNCONFIRMED

export function launchRegionMessage(message: string, places: PlanPlace[]): string {
  return places.length ? `${message}\nConfirmed target locations: ${JSON.stringify(places)}` : message
}

export function allowsLaunchLead(lead: Record<string, unknown>, places: PlanPlace[]): boolean {
  const country = lead.country
  return typeof country === 'string' && LAUNCH_COUNTRIES.has(country)
    && (places.length === 0 || places.some(place => place.country === country))
}

export function addLaunchRegionUsage(search: DiscoverUsage, plan: DiscoverUsage): DiscoverUsage {
  return {
    ...search,
    input_tokens: search.input_tokens + plan.input_tokens,
    output_tokens: search.output_tokens + plan.output_tokens,
    cache_read_tokens: search.cache_read_tokens + plan.cache_read_tokens,
    cache_write_tokens: search.cache_write_tokens + plan.cache_write_tokens,
    requests: search.requests + plan.requests,
    usd: search.usd + plan.usd,
  }
}

function citedUrls(lead: DiscoveredLead) {
  return [lead.evidence_url, lead.person_source_url, lead.email_source_url, lead.linkedin_url]
}

// Only pages cited by in-coverage leads can feed later discovery work such as LinkedIn engagement.
export function launchRegionPages(result: DiscoverResult): string[] {
  const citations = new Set(result.leads.flatMap(citedUrls))
  return result.seen.map(page => page.url).filter(url => citations.has(url))
}
