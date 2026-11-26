// One Claude discovery loop (launch brief, Step 2). Claude reads the request, searches and reads the open web with its own
// web_search and web_fetch tools, and returns typed lead records. Nothing here names a company, place, industry or job title:
// the request and the seller's offer are the only inputs, and Claude decides what to search for.
//
// A record is a claim with its proof attached (evidence_url, signal_date). lib/discover/check.ts then reads the proof page
// itself and labels the record; it never hides one.
import Anthropic from '@anthropic-ai/sdk'
import { profileMarketLines } from './profile-market.ts'
import { DISCOVERY_SONNET_MODEL, DISCOVERY_SONNET_PRICE as PRICE } from './pricing.ts'
import { configuredSearchAllowance, createSearchBudget, searchAllowance, type SearchBudget } from './search-budget.ts'

export const DISCOVER_MODEL = process.env.DAZL_DISCOVER_MODEL?.trim() || DISCOVERY_SONNET_MODEL
const MAX_SEARCHES = process.env.DAZL_DISCOVER_SEARCHES
const MAX_FETCHES = Number(process.env.DAZL_DISCOVER_FETCHES || 12)
const MAX_CONTINUATIONS = 4

export interface DiscoverInput { query: string; offer?: string | null; today?: Date; maxLeads?: number; maxSearches?: number; maxFetches?: number; exclude?: string[]; profile?: DiscoverProfile | null; profileCarried?: boolean }
// The customer's saved buyer profile for this play, in their own words. One they reviewed for THIS search narrows the request; the
// request's own words win where they differ. One carried over unreviewed from an earlier search (profileCarried, #1579) is background
// only: a new typed request for other buyers ran beside "Toronto agencies hiring an SDR" on production and found nothing, twice.
export interface DiscoverProfile { summary?: string; who?: string[]; industries?: string[]; sizes?: string[]; where?: string[]; country?: string; language?: string; exclude?: string[] }
// Whether a job's profile was carried into the search unreviewed (scan_jobs.icp_inferred: 0 = the person reviewed it for this search).
// A saved play's repeat run keeps its own profile as the play's.
export const discoverProfileCarried = (icpInferred: number | null | undefined, watchId: string | null | undefined): boolean => !watchId && icpInferred !== 0
export const CARRIED_PROFILE_HEAD = "Background only, NOT a filter: the seller's usual buyers, saved from an earlier search. Use it only for what the request leaves unsaid, and ignore every part of it that differs from the request:"
export function profileLines(p: DiscoverProfile | null | undefined, carried = false): string[] {
  if (!p) return []
  const list = (label: string, v: unknown) => { const xs = Array.isArray(v) ? v.map(x => str(x, 120)).filter(Boolean).slice(0, 8) : []; return xs.length ? `${label}: ${xs.join('; ')}` : '' }
  const lines = [p.summary ? `Who they sell to: ${str(p.summary, 400)}` : '', list('Buyer roles', p.who), list('Industries', p.industries), list('Company sizes', p.sizes), list(carried ? 'Usual locations (apply only if the request names no place)' : 'Locations (only companies in these places, unless the request names another place)', p.where), ...profileMarketLines(p), list('Leave out', p.exclude)].filter(Boolean)
  return lines.length ? [carried ? CARRIED_PROFILE_HEAD : "The seller's saved buyer profile:", ...lines] : []
}
export interface DiscoveredLead {
  company: string
  domain: string | null
  signal: string
  signal_date: string | null        // YYYY-MM-DD as printed on the proof page, or null
  evidence_url: string              // the page that shows the signal
  evidence_quote: string | null     // the sentence on that page that states the signal, word for word
  alternate_evidence?: { url: string; quote: string; date: string | null }
  person: string | null
  title: string | null
  person_source_url: string | null  // the page that names the person
  linkedin_url: string | null
  email: string | null              // only an address a public page prints for this company or person; never built from a pattern
  email_source_url: string | null   // the page that prints it
  confidence: 'high' | 'medium' | 'low'
  why: string                       // one line: why this company fits the request
}
export interface DiscoverUsage { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; searches: number; requests: number; usd: number }
// A page Claude's own tools returned during the run: a search result (title, and the page's age when the index knows it) or a page it
// opened (its text). check.ts uses these to tell a proof URL the run really saw from one the model made up.
export interface SeenPage { url: string; title: string | null; page_age: string | null; text: string | null }
export interface DiscoverResult { leads: DiscoveredLead[]; usage: DiscoverUsage; stop: string; model: string; note: string | null; seen: SeenPage[] }

const SYSTEM = `You find sales leads for a seller. You are given what the seller sells and who they want to find.

A lead is a real company (or a named person at one) that matches the request AND shows a recent, dated sign that it may need what the seller sells. The sign is whatever the request asks for: hiring, funding, a new leader, an expansion or new location, a public post, and so on.

How to work:
- You have a limited number of searches and page reads. Spend roughly the first half finding companies with the signal and the rest finding the person and website for the best ones. Stop searching and answer before you run out.
- Search for the signal first, in the place and industry the request names. Dated pages make the best proof: news items, press releases, dated blog or social posts, job postings, permit and registry records. Search in the local language too when the place calls for it.
- For each candidate, open the page that proves the signal. Use the date printed on that page for the event. A company's own page often announces something without a date: then look for a dated page about the same event and use that as the proof. If no page prints a date, set signal_date to null; never estimate one. When a page gives an age instead of a date ("Posted 4 days ago"), work the calendar date out from today's date and use it. For a job posting use the date it was posted. For a news item or press release that is itself the announcement, its printed publication date is the date.
- A lead with a dated proof page is worth far more to the seller than one without. Prefer companies whose signal you can date, and spend a search on dating a strong candidate before adding an undated one.
- evidence_url must be a page you opened or one that appeared in your search results, and the company's name must be on it.
- evidence_quote is the sentence on the proof page that states the event itself, copied word for word, 300 characters at most. A job posting usually has no such sentence: there, evidence_quote is the posting's own title line exactly as the page prints it (the role, with the place when it stands on the same line), never a sentence of your own such as "X is hiring a Y". A line that only describes the company (its services, its address, its opening hours) is not a quote for the event. Write signal as one short line that says what that sentence says, keeping the sentence's own words for what happened and its numbers and names. Leave out of signal any detail the proof page does not state.
- The proof page must be about this one company: a single job posting, one news item, a press release, the company's own page. A search-results page, a job-board listing or a directory that shows many companies is not proof, even when the company appears in it. When a listing page shows a promising company, open that company's own posting or careers page and use that as the proof; if you cannot reach one, leave the company out.
- For hiring, prefer a readable employer careers page or the employer's own posting. If a job board requires sign-in, blocks the read, or returns no posting text, use your existing searches and reads to open a source that proves the same opening. Prefer the employer's own page, then another readable page about the same opening. Cite only text actually read. When an Indeed, ZipRecruiter or Talent posting cannot be read, use the employer name, exact role and city from the result in your next search within the existing allowance. Open the exact opening on the employer careers site or their ATS posting. Prefer that posting as evidence. If you keep the aggregator citation and have the employer-side URL and a literal quote from that opening, return alternate_evidence as that URL, quote and its own printed posting date (or null).
- Prefer signals from the last 90 days unless the request gives its own time window. Skip anything clearly older.
- Every qualifier in the request is a requirement, not a hint: "first" (a first sales hire means no sales team yet), "new", a funding stage, a size, an industry, a place. When the page shows the company does not meet one (it already has a sales team, it is a different industry), it is not a lead: leave it out.
- Then find the person the seller should contact at that company: look at the proof page first, then the company's own team, about or contact page. Give a name and title only when a page prints them. Give the person's own LinkedIn profile address (it contains /in/) only when a page links it or a search result shows it for this name at this company; never build one. If you cannot find a person, leave the person fields null and still return the lead.
- Give an email address only when a page prints it for this company or this person, and give that page's URL. Never build an address from a name or a pattern.
- The email must be the named person's own work address. A shared inbox (info@, sales@, hello@, contact@, reception@, founders@ and the like) is not a contact: leave email null rather than give one.
- The company's website domain should be its own site, not a directory or news site. If you are not sure, set it to null.
- Never invent a company, a person, a date, a quote or a URL. Every URL you return must be one you saw in a search result or opened.
- Different companies are worth more than several items about one company. Aim for the number of leads asked for, but return fewer good ones over more weak ones.

confidence: "high" when the proof page clearly shows the dated signal and the company clearly matches the request; "medium" when one of those is partly unclear; "low" when you are unsure but it is still worth a look.

When you are done, reply with ONLY a JSON object inside <json></json> tags, in this shape:
<json>{"leads":[{"company":"","domain":null,"signal":"","signal_date":null,"evidence_url":"","evidence_quote":null,"alternate_evidence":null,"person":null,"title":null,"person_source_url":null,"linkedin_url":null,"email":null,"email_source_url":null,"confidence":"medium","why":""}],"note":null}</json>
Use "note" for one sentence when you found fewer leads than asked for, saying why.`

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')
const httpUrl = (v: unknown): string | null => { const s = str(v, 500); try { const u = new URL(s); return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null } catch { return null } }
const day = (v: unknown): string | null => { const s = str(v, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) ? s : null }
export const publishedEmail = (v: unknown, source: unknown): { email: string | null; email_source_url: string | null } => {
  const e = str(v, 254).toLowerCase(), src = httpUrl(source)
  return src && /^[a-z0-9._%+-]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(e) ? { email: e, email_source_url: src } : { email: null, email_source_url: null }
}
const host = (v: unknown): string | null => {
  const s = str(v, 253).toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/^www\./, '')
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(s) ? s : null
}

// The model's final text -> lead records. Anything that is not a company with a signal and a proof URL is dropped here,
// because without those three there is nothing to show or check.
export function parseLeads(text: string, max: number): { leads: DiscoveredLead[]; note: string | null } {
  const m = /<json>([\s\S]*?)<\/json>/.exec(text)
  let raw: unknown
  try { raw = JSON.parse(m ? m[1] : text) } catch { return { leads: [], note: 'unreadable answer' } }
  const o = (raw && typeof raw === 'object' ? raw : {}) as { leads?: unknown; note?: unknown }
  const out: DiscoveredLead[] = [], seen = new Set<string>()
  for (const item of Array.isArray(o.leads) ? o.leads : []) {
    const l = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
    const company = str(l.company, 150), signal = str(l.signal, 500), evidence_url = httpUrl(l.evidence_url)
    if (!company || !signal || !evidence_url) continue
    const key = company.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const person = str(l.person, 120) || null
    const linkedin = httpUrl(l.linkedin_url)
    const alternate = l.alternate_evidence as { url?: unknown; quote?: unknown; date?: unknown } | null | undefined
    const alternateUrl = httpUrl(alternate?.url), alternateQuote = str(alternate?.quote, 300)
    out.push({
      company, signal, evidence_url, domain: host(l.domain), signal_date: day(l.signal_date), evidence_quote: str(l.evidence_quote, 300) || null,
      ...(alternateUrl && alternateQuote ? { alternate_evidence: { url: alternateUrl, quote: alternateQuote, date: day(alternate?.date) } } : {}),
      person, title: person ? str(l.title, 150) || null : null, person_source_url: person ? httpUrl(l.person_source_url) : null,
      // a person's own profile only (/in/<name>): a company page is not the person's LinkedIn (#1037)
      linkedin_url: linkedin && /(^|\.)linkedin\.com$/.test(new URL(linkedin).hostname) && /^\/in\/[^/]{2,}\/?$/.test(new URL(linkedin).pathname) ? linkedin : null,
      ...publishedEmail(l.email, l.email_source_url),
      confidence: l.confidence === 'high' || l.confidence === 'low' ? l.confidence : 'medium', why: str(l.why, 300),
    })
    if (out.length >= max) break
  }
  return { leads: out, note: str(o.note, 300) || null }
}

export function usd(u: Omit<DiscoverUsage, 'usd'>): number {
  return Math.round(((u.input_tokens * PRICE.input + u.output_tokens * PRICE.output + u.cache_read_tokens * PRICE.cacheRead + u.cache_write_tokens * PRICE.cacheWrite) / 1e6 + u.searches * PRICE.search) * 10000) / 10000
}

// What the engine is asked, as one message. With a carried profile the request is named as the whole search before the background.
export function userMessage(input: DiscoverInput, today: string, max: number): string {
  const profile = profileLines(input.profile, input.profileCarried === true)
  return [`Today is ${today}.`, input.offer ? `The seller sells: ${str(input.offer, 600)}` : '', `Find: ${str(input.query, 1000)}`,
    input.profileCarried === true && profile.length ? 'The request above is the whole search: it decides who to look for, where, and which signal.' : '',
    ...profile,
    // a play that runs again: the companies it already found are not leads this time
    input.exclude?.length ? `Already found, do not return these companies again: ${input.exclude.slice(0, 80).map(c => str(c, 80)).filter(Boolean).join('; ')}` : '',
    `Return up to ${max} leads.`].filter(Boolean).join('\n')
}

export async function discoverLeads(input: DiscoverInput, deps: { apiKey: string; fetch?: typeof fetch; signal?: AbortSignal; searchBudget?: SearchBudget }): Promise<DiscoverResult> {
  const max = Math.min(Math.max(input.maxLeads ?? 10, 1), 20)
  if (DISCOVER_MODEL !== 'claude-sonnet-5-5') throw new Error('Discovery requires the supported Sonnet cost policy')
  const allowance = Math.min(searchAllowance(input.maxSearches), configuredSearchAllowance(MAX_SEARCHES))
  const searches = deps.searchBudget ?? createSearchBudget(allowance)
  const client = new Anthropic({ apiKey: deps.apiKey, fetch: deps.fetch, maxRetries: 0 })
  const today = (input.today ?? new Date()).toISOString().slice(0, 10)
  const user = userMessage(input, today, max)
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: user }]
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, searches: 0, requests: 0 }
  let text = '', stop = 'unknown', model = DISCOVER_MODEL
  const seen = new Map<string, SeenPage>()
  for (let turn = 0; turn <= MAX_CONTINUATIONS; turn++) {
    const reservation = await searches.reserve(allowance)
    const finalAnswer = allowance > 0 && reservation.allowance === 0
    if (finalAnswer && turn === 0) {
      stop = 'search_cap'
      break
    }
    // A paused response may contain paid tool results without a final answer. Reuse that transcript once.
    const system = finalAnswer
      ? SYSTEM + '\nThe search allowance is exhausted. Return the final JSON now with every supported company you already found. Do not call tools or invent results.'
      : SYSTEM
    const res = await client.beta.messages.stream({
      model: DISCOVER_MODEL, max_tokens: 16000, service_tier: 'standard_only',
      output_config: { effort: 'medium' },
      // Caching is what keeps this loop affordable: every search adds its results to the prompt, and without a cache point the whole
      // growing prompt is billed at full price on each step (measured: US$2.16 a prompt without it, US$0.41 with it).
      cache_control: { type: 'ephemeral' },
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      ...(finalAnswer ? { tool_choice: { type: 'none' as const } } : {}),
      tools: [
        ...(reservation.allowance > 0 ? [{ type: 'web_search_20250305' as const, name: 'web_search' as const, max_uses: reservation.allowance }] : []),
        { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: Math.max(1, input.maxFetches ?? MAX_FETCHES), max_content_tokens: 6000 },
      ],
      messages,
    }, { signal: deps.signal }).finalMessage()
    if (![res.usage.input_tokens, res.usage.output_tokens, res.usage.cache_read_input_tokens, res.usage.cache_creation_input_tokens]
      .every(n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)) {
      throw new Error('Discovery usage is unavailable; reservation retained')
    }
    if (res.model !== DISCOVER_MODEL) throw new Error('Discovery served an unexpected model; reservation retained')
    await reservation.settle(reservation.allowance === 0 ? 0 : res.usage.server_tool_use?.web_search_requests)
    usage.requests++
    usage.input_tokens += res.usage.input_tokens ?? 0
    usage.output_tokens += res.usage.output_tokens ?? 0
    usage.cache_read_tokens += res.usage.cache_read_input_tokens ?? 0
    usage.cache_write_tokens += res.usage.cache_creation_input_tokens ?? 0
    usage.searches += res.usage.server_tool_use?.web_search_requests ?? 0
    stop = res.stop_reason ?? 'unknown'
    model = res.model
    for (const b of res.content) {
      if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) for (const r of b.content) if (r.type === 'web_search_result' && !seen.has(r.url)) seen.set(r.url, { url: r.url, title: r.title ?? null, page_age: r.page_age ?? null, text: null })
      if (b.type === 'web_fetch_tool_result' && b.content.type === 'web_fetch_result') {
        const src = b.content.content?.source
        seen.set(b.content.url, { url: b.content.url, title: b.content.content?.title ?? seen.get(b.content.url)?.title ?? null, page_age: seen.get(b.content.url)?.page_age ?? null, text: src && src.type === 'text' ? src.data.slice(0, 400_000) : null })
      }
    }
    const answer = res.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map(b => b.text).join('')
    if (finalAnswer) {
      if ((res.usage.server_tool_use?.web_search_requests ?? 0) !== 0) throw new Error('The final discovery answer reported a search outside its allowance')
      const hasEarlierLeads = parseLeads(text, max).leads.length > 0
      if (stop !== 'refusal' && (!hasEarlierLeads || parseLeads(answer, max).leads.length > 0)) text = answer
      if (stop !== 'refusal' || hasEarlierLeads) stop = 'search_cap'
      break
    }
    text = answer
    // The server-side tool loop paused: send the turn back unchanged and it resumes where it stopped.
    if (stop !== 'pause_turn') break
    messages.push({ role: 'assistant', content: res.content as Anthropic.Beta.BetaContentBlockParam[] })
  }
  const parsed = stop === 'refusal' ? { leads: [], note: 'the model declined this request' } : parseLeads(text, max)
  return { ...parsed, usage: { ...usage, usd: usd(usage) }, stop, model, seen: [...seen.values()] }
}
