// Launch brief Step 2: discovery as ONE Claude agent loop. Claude reads the request into a structured plan, searches (web_search) and
// reads pages (web_fetch) itself, and hands back typed leads through one strict client tool, submit_leads:
//   {company, domain, signal, signal_date, evidence_url, person, title, person_source_url, linkedin_url, confidence}.
// No regexes read the request and no place / industry / title lists: the plan is Claude's own reading (#1394, #1395).
// It starts from the cf_runner company-first prototype: the same discover rules (lib/discovery/cf-runner-prompts.ts).
//
// What dazl checks, in code, on what comes back (validateAgentLeads) - show, don't hide (brief Step 3):
//  - a lead is SHOWN when it has a company, a valid past signal date and an evidence URL that a tool in THIS loop actually returned
//    (a search result, a fetched page or a citation): nothing the model only typed counts as evidence;
//  - a person, a domain or a LinkedIn profile that no returned URL backs is not shown as found: it becomes null, is named in `missing`,
//    and lowers the confidence label; it never hides the lead.
// Raw HTTP on an injected fetch, like dazl's other Claude calls (lib/llm/claude-web-search.ts). Not wired into any scan path yet.
import { CF_BOARD_PREFERENCE, CF_RUNNER_RULES } from './cf-runner-prompts.ts'

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages'
// Per-1M-token prices (input, output, cache read) of the models this loop may run; cache writes are 1.25x input. Search: $10 per 1,000.
const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
}
const USD_PER_SEARCH = 0.01
export const DISCOVERY_AGENT_MODEL = 'claude-sonnet-5-5'

export type Confidence = 'high' | 'medium' | 'low'
export interface AgentLead {
  company: string; domain: string | null; signal: string; signal_date: string; evidence_url: string
  person: string | null; title: string | null; person_source_url: string | null; linkedin_url: string | null
  confidence: Confidence
  missing: ('domain' | 'person' | 'linkedin')[]   // what the card says plainly is missing
}
export interface AgentPlan { service: string; place: string | null; signal: string; window_days: number | null; people: string[] }
export type AgentStop = 'submitted' | 'no_submit' | 'budget' | 'max_turns' | 'refusal' | 'max_tokens'
export interface AgentUsage { turns: number; input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; web_search_requests: number; web_fetch_requests: number; cost_usd: number }
export interface AgentResult { stop: AgentStop; plan: AgentPlan | null; leads: AgentLead[]; rejected: { company: string; reason: string }[]; usage: AgentUsage }
export type DiscoveryAgentErrorCode = 'invalid_input' | 'key_rejected' | 'rate_limited' | 'api_error' | 'transport'
export class DiscoveryAgentError extends Error {
  readonly code: DiscoveryAgentErrorCode
  constructor(code: DiscoveryAgentErrorCode, detail?: string) { super(detail ? `${code}: ${detail}` : code); this.code = code }
}

export interface AgentOptions {
  apiKey: string; request: string; fetchImpl?: typeof fetch; now?: number
  model?: string; maxTurns?: number; budgetUsd?: number; maxSearches?: number; maxFetches?: number; maxLeads?: number; timeoutMs?: number
}

const nullable = (type: string) => ({ type: [type, 'null'] })
const LEAD_KEYS = ['company', 'domain', 'signal', 'signal_date', 'evidence_url', 'person', 'title', 'person_source_url', 'linkedin_url', 'confidence'] as const
const SUBMIT_TOOL = {
  name: 'submit_leads',
  description: 'Submit your reading of the request (plan) and every lead you found, once, when you are done searching and reading.',
  strict: true,
  input_schema: {
    type: 'object', additionalProperties: false, required: ['plan', 'leads'],
    properties: {
      plan: {
        type: 'object', additionalProperties: false, required: ['service', 'place', 'signal', 'window_days', 'people'],
        properties: {
          service: { type: 'string', description: 'the kind of company the request is for' },
          place: { ...nullable('string'), description: 'where, as the request says it; null if it names no place' },
          signal: { type: 'string', description: 'the dated event that shows intent' },
          window_days: { ...nullable('integer'), description: 'how recent the signal must be, in days; null if the request says nothing' },
          people: { type: 'array', items: { type: 'string' }, description: 'the decision-maker titles to name at each company' },
        },
      },
      leads: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false, required: [...LEAD_KEYS],
          properties: {
            company: { type: 'string' }, domain: { ...nullable('string'), description: "the company's own website domain" },
            signal: { type: 'string', description: 'what happened, in one sentence' },
            signal_date: { ...nullable('string'), description: 'YYYY-MM-DD, the date the evidence page gives for the signal' },
            evidence_url: { type: 'string', description: 'the page that proves the signal: a URL a search returned or you fetched' },
            person: nullable('string'), title: nullable('string'),
            person_source_url: { ...nullable('string'), description: 'the page that names this person in this role' },
            linkedin_url: { ...nullable('string'), description: "the person's linkedin.com/in/ profile, only if a search returned it" },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          },
        },
      },
    },
  },
}

function systemPrompt(maxLeads: number): string {
  return [
    'You find B2B sales leads for the request in the user message. First read the request into a plan: the kind of company, the place (if any), the intent signal, how recent it must be, and the decision-maker titles to name.',
    'Then use web_search to find companies showing that signal, and web_fetch to read the pages that prove it (dated) and the company\'s own team / about / leadership page to name the decision-maker.',
    `Find up to ${maxLeads} distinct companies. For each: its own website domain; the signal in one sentence; the date the evidence page gives (YYYY-MM-DD); the evidence page URL (one a search returned or you fetched - never a guessed URL); the decision-maker's name and title with the page that names them; their linkedin.com/in/ profile only if a search returned it; and your confidence.`,
    'Use null for anything you could not find. Do not guess names, titles, dates or URLs.',
    CF_RUNNER_RULES,
    `If the signal is hiring: ${CF_BOARD_PREFERENCE}`,
    'When you are done, call submit_leads once with the plan and every lead.',
  ].join('\n\n')
}

// ---- provenance: the URLs a tool actually returned in this loop ----
function canon(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 2000) return null
  try {
    const u = new URL(raw.trim())
    if (u.protocol !== 'https:' || u.username || u.password) return null
    u.hash = ''
    const s = u.href
    return u.pathname.length > 1 && s.endsWith('/') ? s.slice(0, -1) : s
  } catch { return null }
}
const obj = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
function collectSeen(content: unknown[], seen: Set<string>): void {
  for (const b of content) {
    const block = obj(b)
    if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
      for (const r of block.content) { const c = canon(obj(r).url); if (c) seen.add(c) }
    } else if (block.type === 'web_fetch_tool_result') {
      const r = obj(block.content); if (r.type === 'web_fetch_result') { const c = canon(r.url); if (c) seen.add(c) }
    } else if (block.type === 'text' && Array.isArray(block.citations)) {
      for (const cit of block.citations) { const c = canon(obj(cit).url); if (c) seen.add(c) }
    }
  }
}

// ---- validation: what is shown, and what is plainly missing ----
const str = (v: unknown, max: number): string | null => typeof v === 'string' && v.trim() && v.trim().length <= max ? v.trim() : null
const LINKEDIN_PROFILE = /^https:\/\/(?:www\.|[a-z]{2}\.)?linkedin\.com\/in\/[^/?#]+$/i
function hostOf(raw: unknown): string | null {
  const s = str(raw, 253); if (!s) return null
  try { const h = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`).hostname.toLowerCase().replace(/^www\./, ''); return h.includes('.') ? h : null } catch { return null }
}
function validDate(v: unknown, now: number): string | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null
  const t = Date.parse(`${v}T00:00:00Z`)
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== v) return null
  return t <= now + 86_400_000 ? v : null
}
const RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 }
const cap = (c: Confidence, max: Confidence): Confidence => (RANK[c] > RANK[max] ? max : c)

export function validateAgentLeads(raw: unknown[], seenUrls: Set<string>, now: number = Date.now()): { leads: AgentLead[]; rejected: { company: string; reason: string }[] } {
  const seen = new Set([...seenUrls].map(canon).filter((u): u is string => !!u))
  const seenHosts = [...seen].map(u => new URL(u).hostname.toLowerCase().replace(/^www\./, ''))
  const leads: AgentLead[] = [], rejected: { company: string; reason: string }[] = [], companies = new Set<string>()
  for (const item of raw) {
    const r = obj(item), name = typeof r.company === 'string' ? r.company.trim() : ''
    const company = str(r.company, 120)
    if (!company) { rejected.push({ company: name, reason: 'no_company' }); continue }
    const signal = str(r.signal, 400)
    if (!signal) { rejected.push({ company, reason: 'no_signal' }); continue }
    const signal_date = validDate(r.signal_date, now)
    if (!signal_date) { rejected.push({ company, reason: 'signal_date_invalid' }); continue }
    const evidence = canon(r.evidence_url)
    if (!evidence || !seen.has(evidence)) { rejected.push({ company, reason: 'evidence_url_not_seen' }); continue }
    const key = company.toLowerCase().replace(/\s+/g, ' ')
    if (companies.has(key)) continue
    companies.add(key)
    const missing: AgentLead['missing'] = []
    // the domain is shown only when a returned URL is on it (an unproven domain could be another company's)
    const host = hostOf(r.domain)
    const domain = host && seenHosts.some(h => h === host || h.endsWith(`.${host}`)) ? host : null
    if (!domain) missing.push('domain')
    // the person is shown only with a source a tool returned: the page naming them, or their LinkedIn profile
    const linkedinCanon = canon(r.linkedin_url)
    const linkedinSeen = !!linkedinCanon && LINKEDIN_PROFILE.test(linkedinCanon) && seen.has(linkedinCanon)
    const sourceCanon = canon(r.person_source_url), sourceSeen = !!sourceCanon && seen.has(sourceCanon)
    const personName = str(r.person, 120)
    const person = personName && (sourceSeen || linkedinSeen) ? personName : null
    if (!person) missing.push('person')
    const linkedin_url = person && linkedinSeen ? linkedinCanon : null
    if (!linkedin_url) missing.push('linkedin')
    const stated: Confidence = r.confidence === 'high' || r.confidence === 'medium' || r.confidence === 'low' ? r.confidence : 'low'
    const gaps = (domain ? 0 : 1) + (person ? 0 : 1)
    leads.push({
      company, domain, signal, signal_date, evidence_url: evidence,
      person, title: person ? str(r.title, 160) : null, person_source_url: person && sourceSeen ? sourceCanon : null, linkedin_url,
      confidence: gaps === 0 ? stated : gaps === 1 ? cap(stated, 'medium') : 'low',
      missing,
    })
  }
  return { leads, rejected }
}

function readPlan(v: unknown): AgentPlan | null {
  const p = obj(v)
  const service = str(p.service, 200), signal = str(p.signal, 400)
  if (!service || !signal || !Array.isArray(p.people)) return null
  return {
    service, signal, place: str(p.place, 200),
    window_days: typeof p.window_days === 'number' && Number.isSafeInteger(p.window_days) && p.window_days > 0 ? p.window_days : null,
    people: p.people.map(x => str(x, 120)).filter((x): x is string => !!x).slice(0, 10),
  }
}

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)

export async function runDiscoveryAgent(o: AgentOptions): Promise<AgentResult> {
  const model = o.model ?? DISCOVERY_AGENT_MODEL, price = PRICES[model]
  if (!o.apiKey?.trim() || !o.request?.trim() || o.request.length > 4000 || !price) throw new DiscoveryAgentError('invalid_input')
  const fetchImpl = o.fetchImpl ?? fetch, now = o.now ?? Date.now()
  const maxTurns = o.maxTurns ?? 8, budget = o.budgetUsd ?? 1, maxLeads = o.maxLeads ?? 15
  const tools = [
    { type: 'web_search_20260209', name: 'web_search', max_uses: o.maxSearches ?? 8 },
    { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: o.maxFetches ?? 12 },
    SUBMIT_TOOL,
  ]
  const system = systemPrompt(maxLeads)
  const messages: { role: 'user' | 'assistant'; content: unknown }[] = [{ role: 'user', content: o.request.trim() }]
  const seen = new Set<string>()
  const usage: AgentUsage = { turns: 0, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, web_search_requests: 0, web_fetch_requests: 0, cost_usd: 0 }
  const done = (stop: AgentStop, plan: AgentPlan | null = null, leads: AgentLead[] = [], rejected: { company: string; reason: string }[] = []): AgentResult => ({ stop, plan, leads, rejected, usage })
  let nudged = false
  for (let turn = 0; turn < maxTurns; turn++) {
    let res: Response
    try {
      res = await fetchImpl(MESSAGES_URL, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(o.timeoutMs ?? 300_000),
        headers: { 'content-type': 'application/json', 'x-api-key': o.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: 16_000, system, messages, tools, tool_choice: { type: 'auto' } }),
      })
    } catch (e) { throw new DiscoveryAgentError('transport', e instanceof Error ? e.message : undefined) }
    if (res.status === 401 || res.status === 403) throw new DiscoveryAgentError('key_rejected')
    if (res.status === 429) throw new DiscoveryAgentError('rate_limited')
    if (!res.ok) throw new DiscoveryAgentError('api_error', String(res.status))
    let msg: Record<string, unknown>
    try { msg = obj(await res.json()) } catch { throw new DiscoveryAgentError('api_error', 'unreadable response') }
    const content = Array.isArray(msg.content) ? msg.content : []
    const u = obj(msg.usage), st = obj(u.server_tool_use)
    usage.turns++
    usage.input_tokens += n(u.input_tokens); usage.output_tokens += n(u.output_tokens)
    usage.cache_read_input_tokens += n(u.cache_read_input_tokens); usage.cache_creation_input_tokens += n(u.cache_creation_input_tokens)
    usage.web_search_requests += n(st.web_search_requests); usage.web_fetch_requests += n(st.web_fetch_requests)
    usage.cost_usd = (usage.input_tokens * price.input + usage.output_tokens * price.output + usage.cache_read_input_tokens * price.cacheRead + usage.cache_creation_input_tokens * price.input * 1.25) / 1_000_000
      + usage.web_search_requests * USD_PER_SEARCH
    collectSeen(content, seen)
    const submitted = content.map(obj).find(b => b.type === 'tool_use' && b.name === 'submit_leads')
    if (submitted) {
      const input = obj(submitted.input)
      const { leads, rejected } = validateAgentLeads(Array.isArray(input.leads) ? input.leads : [], seen, now)
      return done('submitted', readPlan(input.plan), leads, rejected)
    }
    const stop = msg.stop_reason
    if (stop === 'refusal') return done('refusal')
    if (stop === 'max_tokens') return done('max_tokens')
    if (stop === 'pause_turn') messages.push({ role: 'assistant', content })
    else if (!nudged) {   // end_turn (or a tool call other than submit_leads): ask once for the submission
      nudged = true
      messages.push({ role: 'assistant', content }, { role: 'user', content: 'Call submit_leads now with the plan and every lead you found (an empty list if none).' })
    } else return done('no_submit')
    if (usage.cost_usd >= budget) return done('budget')
  }
  return done('max_turns')
}
