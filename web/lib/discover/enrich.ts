// Second pass of the discovery loop: for a lead that came back without a person or a website, one small Claude call looks for
// just that. The first pass spends its searches finding companies with the signal; this pass spends a few on each company's
// own people. It runs on the small model, in parallel, and only fills fields that are empty. It never changes the signal,
// its date or its proof, and never replaces a person the first pass already found.
import Anthropic from '@anthropic-ai/sdk'
import { publishedEmail, type DiscoveredLead, type DiscoverUsage, type SeenPage } from './agent.ts'

export const ENRICH_MODEL = process.env.DAZL_DISCOVER_ENRICH_MODEL?.trim() || 'claude-haiku-5-5'
// US$ per million tokens for the default small model, and per web search.
const PRICE = { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, search: 0.01 }
const MAX_SEARCHES = Number(process.env.DAZL_DISCOVER_ENRICH_SEARCHES || 4)
const MAX_FETCHES = Number(process.env.DAZL_DISCOVER_ENRICH_FETCHES || 2)

const SYSTEM = `You are given one company and what a seller wants to sell to it. Find these on the open web:
1. the company's own website domain;
2. the person at that company the seller should contact: the owner, founder or the leader of the team that would buy this. Give a name and title only when a page prints them, with that page's URL. If the request says "Person already found", keep that person and do not look for another.

3. that person's own LinkedIn profile. Search for the person's full name with the company name and the word LinkedIn. Give the profile address (it contains /in/) only when a search result or a page shows it with this same name and this company. A company page (/company/) is not a profile. Never build or guess a profile address.
4. that person's own work email address, only if a page prints it, with that page's URL. A shared inbox (info@, sales@, hello@, contact@, reception@ and the like) is not a contact: leave email null rather than give one. Never build an address from a name.

The company's own website (team, about, leadership, contact pages), a press release or a news item that names the person are good sources. Make sure the person works at THIS company: the same name at another company is a wrong answer. If you cannot find a person, say so with nulls. Never guess a name, a title or a URL.

Reply with ONLY a JSON object inside <json></json> tags:
<json>{"domain":null,"person":null,"title":null,"person_source_url":null,"linkedin_url":null,"email":null,"email_source_url":null}</json>`

export interface Enriched { domain: string | null; person: string | null; title: string | null; person_source_url: string | null; linkedin_url: string | null; email: string | null; email_source_url: string | null }
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')
const httpUrl = (v: unknown): string | null => { const s = str(v, 500); try { const u = new URL(s); return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null } catch { return null } }
const host = (v: unknown): string | null => {
  const s = str(v, 253).toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/^www\./, '')
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(s) ? s : null
}
// A person's own profile: a LinkedIn host and a path /in/<name>. A company page, a post or a search page is not one.
const isProfileUrl = (url: string): boolean => { try { const u = new URL(url); return /(^|\.)linkedin\.com$/.test(u.hostname) && /^\/in\/[^/]{2,}\/?$/.test(u.pathname) } catch { return false } }
const profileKey = (url: string): string | null => { try { const u = new URL(url); return isProfileUrl(url) ? decodeURIComponent(u.pathname).toLowerCase().replace(/\/$/, '') : null } catch { return null } }
// The same person: the same first and last name, ignoring case, accents, spacing, a title (Dr.) and middle names or initials.
const nameParts = (n: string | null): string[] => (n ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/\b(?:dr|mr|mrs|ms|prof)\.?\s/g, ' ').match(/[a-z]{2,}/g) ?? []
export const samePerson = (a: string | null, b: string | null): boolean => { const x = nameParts(a), y = nameParts(b); return x.length >= 2 && y.length >= 2 && x[0] === y[0] && x[x.length - 1] === y[y.length - 1] }
// #1037: a profile address is kept only when the run saw it (a search result or a page it opened). One it never saw may be made up.
export function keepSeenProfile(e: Enriched, seen: ReadonlyMap<string, SeenPage>): Enriched {
  if (!e.linkedin_url) return e
  const want = profileKey(e.linkedin_url)
  for (const url of seen.keys()) if (want && profileKey(url) === want) return e
  return { ...e, linkedin_url: null }
}
export function parseEnriched(text: string): Enriched {
  const none = { domain: null, person: null, title: null, person_source_url: null, linkedin_url: null, email: null, email_source_url: null }
  const m = /<json>([\s\S]*?)<\/json>/.exec(text)
  let o: Record<string, unknown>
  try { const raw = JSON.parse(m ? m[1] : text) as unknown; o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {} } catch { return none }
  const person = str(o.person, 120) || null, source = person ? httpUrl(o.person_source_url) : null
  const linkedin = httpUrl(o.linkedin_url)
  // a person with no page that names them is not kept: the name could not be shown with its source
  const mail = publishedEmail(o.email, o.email_source_url)
  if (person && !source) return { ...none, ...mail, domain: host(o.domain) }
  return { ...mail, domain: host(o.domain), person, title: person ? str(o.title, 150) || null : null, person_source_url: source,
    linkedin_url: person && linkedin && isProfileUrl(linkedin) ? linkedin : null }
}

// #1037: a named person with no LinkedIn profile still needs the pass
export const needsEnrichment = (l: DiscoveredLead): boolean => !l.person || !l.domain || !l.email || !l.linkedin_url
export function mergeEnriched(l: DiscoveredLead, e: Enriched): DiscoveredLead {
  // the first pass's person is never replaced; a profile found for that SAME person fills an empty one (#1037)
  const person = l.person ? (!l.linkedin_url && e.linkedin_url && samePerson(l.person, e.person) ? { linkedin_url: e.linkedin_url } : {})
    : { person: e.person, title: e.title, person_source_url: e.person_source_url, linkedin_url: l.linkedin_url ?? e.linkedin_url }
  return { ...l, domain: l.domain ?? e.domain, ...person, ...(l.email ? {} : { email: e.email, email_source_url: e.email_source_url }) }
}

const usdOf = (u: Omit<DiscoverUsage, 'usd'>) => Math.round(((u.input_tokens * PRICE.input + u.output_tokens * PRICE.output + u.cache_read_tokens * PRICE.cacheRead + u.cache_write_tokens * PRICE.cacheWrite) / 1e6 + u.searches * PRICE.search) * 10000) / 10000

export const enrichRequest = (lead: DiscoveredLead, offer: string | null): string => [`Company: ${lead.company}`, lead.domain ? `Website: ${lead.domain}` : '', `What we know: ${lead.signal}`, `Where we read it: ${lead.evidence_url}`,
  lead.person ? `Person already found: ${[lead.person, lead.title].filter(Boolean).join(', ')}` : '', offer ? `The seller sells: ${str(offer, 400)}` : ''].filter(Boolean).join('\n')

async function enrichOne(client: Anthropic, lead: DiscoveredLead, offer: string | null, seen: Map<string, SeenPage>, usage: Omit<DiscoverUsage, 'usd'>, signal?: AbortSignal): Promise<Enriched> {
  const user = enrichRequest(lead, offer)
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: user }]
  let text = ''
  for (let turn = 0; turn < 3; turn++) {
    const res = await client.messages.stream({
      model: ENRICH_MODEL, max_tokens: 4000, system: SYSTEM,
      tools: [
        { type: 'web_search_20250305', name: 'web_search', max_uses: MAX_SEARCHES },
        { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: MAX_FETCHES, max_content_tokens: 4000 },
      ],
      messages,
    }, { signal }).finalMessage()
    usage.requests++
    usage.input_tokens += res.usage.input_tokens ?? 0
    usage.output_tokens += res.usage.output_tokens ?? 0
    usage.cache_read_tokens += res.usage.cache_read_input_tokens ?? 0
    usage.cache_write_tokens += res.usage.cache_creation_input_tokens ?? 0
    usage.searches += res.usage.server_tool_use?.web_search_requests ?? 0
    for (const b of res.content) {
      if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) for (const r of b.content) if (r.type === 'web_search_result' && !seen.has(r.url)) seen.set(r.url, { url: r.url, title: r.title ?? null, page_age: r.page_age ?? null, text: null })
      if (b.type === 'web_fetch_tool_result' && b.content.type === 'web_fetch_result') {
        const src = b.content.content?.source
        seen.set(b.content.url, { url: b.content.url, title: b.content.content?.title ?? null, page_age: null, text: src && src.type === 'text' ? src.data.slice(0, 200_000) : null })
      }
    }
    text = res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map(b => b.text).join('')
    if (res.stop_reason !== 'pause_turn') break
    messages.push({ role: 'assistant', content: res.content as Anthropic.ContentBlockParam[] })
  }
  return keepSeenProfile(parseEnriched(text), seen)
}

// Fills the empty person and website fields of the leads that need it. A lead whose call fails is returned unchanged.
export async function enrichLeads(leads: DiscoveredLead[], o: { offer?: string | null; maxLeads?: number }, deps: { apiKey: string; fetch?: typeof fetch; signal?: AbortSignal }, concurrency = 4): Promise<{ leads: DiscoveredLead[]; usage: DiscoverUsage; seen: SeenPage[]; enriched: number }> {
  const client = new Anthropic({ apiKey: deps.apiKey, fetch: deps.fetch, maxRetries: 2 })
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, searches: 0, requests: 0 }
  const seen = new Map<string, SeenPage>()
  const out = [...leads]
  const todo = leads.map((l, i) => ({ l, i })).filter(x => needsEnrichment(x.l)).slice(0, o.maxLeads ?? 12)
  let next = 0, enriched = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, async () => {
    for (let k = next++; k < todo.length; k = next++) {
      const { l, i } = todo[k]
      try {
        const merged = mergeEnriched(l, await enrichOne(client, l, o.offer ?? null, seen, usage, deps.signal))
        if (merged.person !== l.person || merged.domain !== l.domain || merged.linkedin_url !== l.linkedin_url) enriched++
        out[i] = merged
      } catch { /* this lead stays as the first pass left it */ }
    }
  }))
  return { leads: out, usage: { ...usage, usd: usdOf(usage) }, seen: [...seen.values()], enriched }
}
