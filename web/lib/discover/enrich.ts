// Second pass of the discovery loop: for a lead that came back without a person or a website, one small Claude call looks for
// just that. The first pass spends its searches finding companies with the signal; this pass spends a few on each company's
// own people. It runs on the small model, in parallel, and only fills fields that are empty. It never changes the signal,
// its date or its proof, and never replaces a person the first pass already found.
import Anthropic from '@anthropic-ai/sdk'
import { publishedEmail, type DiscoveredLead, type DiscoverUsage, type SeenPage } from './agent.ts'

export const ENRICH_MODEL = process.env.DAZL_DISCOVER_ENRICH_MODEL?.trim() || 'claude-haiku-5-5'
// US$ per million tokens for the default small model, and per web search.
const PRICE = { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, search: 0.01 }
const MAX_SEARCHES = Number(process.env.DAZL_DISCOVER_ENRICH_SEARCHES || 3)
const MAX_FETCHES = Number(process.env.DAZL_DISCOVER_ENRICH_FETCHES || 2)

const SYSTEM = `You are given one company and what a seller wants to sell to it. Find two things on the open web:
1. the company's own website domain;
2. the person at that company the seller should contact: the owner, founder or the leader of the team that would buy this. Give a name and title only when a page prints them, with that page's URL. Give a LinkedIn URL only when a page or a search result shows it for that person at that company.

3. an email address for that person or the company, only if a page prints it, with that page's URL. Never build one from a name.

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
    linkedin_url: person && linkedin && /(^|\.)linkedin\.com$/.test(new URL(linkedin).hostname) ? linkedin : null }
}

export const needsEnrichment = (l: DiscoveredLead): boolean => !l.person || !l.domain || !l.email
export function mergeEnriched(l: DiscoveredLead, e: Enriched): DiscoveredLead {
  const person = l.person ? {} : { person: e.person, title: e.title, person_source_url: e.person_source_url, linkedin_url: l.linkedin_url ?? e.linkedin_url }
  return { ...l, domain: l.domain ?? e.domain, ...person, ...(l.email ? {} : { email: e.email, email_source_url: e.email_source_url }) }
}

const usdOf = (u: Omit<DiscoverUsage, 'usd'>) => Math.round(((u.input_tokens * PRICE.input + u.output_tokens * PRICE.output + u.cache_read_tokens * PRICE.cacheRead + u.cache_write_tokens * PRICE.cacheWrite) / 1e6 + u.searches * PRICE.search) * 10000) / 10000

async function enrichOne(client: Anthropic, lead: DiscoveredLead, offer: string | null, seen: Map<string, SeenPage>, usage: Omit<DiscoverUsage, 'usd'>, signal?: AbortSignal): Promise<Enriched> {
  const user = [`Company: ${lead.company}`, lead.domain ? `Website: ${lead.domain}` : '', `What we know: ${lead.signal}`, `Where we read it: ${lead.evidence_url}`, offer ? `The seller sells: ${str(offer, 400)}` : ''].filter(Boolean).join('\n')
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
  return parseEnriched(text)
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
        if (merged.person !== l.person || merged.domain !== l.domain) enriched++
        out[i] = merged
      } catch { /* this lead stays as the first pass left it */ }
    }
  }))
  return { leads: out, usage: { ...usage, usd: usdOf(usage) }, seen: [...seen.values()], enriched }
}
