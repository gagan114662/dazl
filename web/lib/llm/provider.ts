import type { Vendor } from './vendors.ts'

// A research call: the model searches the web and answers. Each vendor's own
// web-search tool is used, so the cost lands on the tenant's own key.
export interface ResearchResult {
  text: string
  // URLs the vendor actually returned from search or cited. Leads may only cite these.
  citedUrls: string[]
  // What the call used, as the vendor reported it (absent when it did not say): tokens billed, including search
  // results read back as input, and how many web searches it ran. A trial scan's spend is settled to this.
  usage?: { model?: string; input_tokens?: number; output_tokens?: number; web_search_requests?: number }
}

export class ProviderError extends Error {
  // 'auth': key rejected (do not retry). 'retry': timeout, 429, 5xx, bad output.
  kind: 'auth' | 'retry'
  // What the failed request may have cost (#363):
  //  'uncertain' = it may have been processed and billed (timeout or dropped connection after send, 5xx, an unlisted status, an unreadable answer,
  //                anything unclassified). Its reservation stays unsettled; the scan ends accounting_uncertain; nothing retries it.
  //  'rejected'  = the vendor answered with a documented rejection status (see DECLINED_STATUS). dazl does NOT claim it was uncharged, so it is
  //                never retried automatically either: the scan ends 'provider_rejected' / 'provider_rate_limited' and the owner retries on purpose.
  //  'none'      = no vendor request is outstanding (an answer already settled and then judged unusable, or a failure before anything was sent):
  //                the ordinary retry applies.
  charge: 'uncertain' | 'rejected' | 'none'
  status?: number
  constructor(kind: 'auth' | 'retry', message: string, charge: 'uncertain' | 'rejected' | 'none' = 'uncertain', status?: number) {
    super(message)
    this.kind = kind
    this.charge = charge
    if (status !== undefined) this.status = status
  }
}

export interface CompletionUsage { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
// What a paid completion cost in provider terms. No secrets, no prompt or response
// content - just the accounting fields a tenant needs to see what a call used.
// model is the SERVED model from the response, or null when the response omits it -
// never the requested model mislabeled as what was actually served.
export interface DetailedCompletion { text: string; model: string | null; request_id?: string; usage?: CompletionUsage }

// Only fields the provider actually reported are present - missing stays absent,
// never a fabricated zero.
function usageOf(fields: Record<string, number | undefined>): CompletionUsage | undefined {
  const out: CompletionUsage = {}
  let any = false
  for (const [k, v] of Object.entries(fields)) if (typeof v === 'number') { (out as Record<string, number>)[k] = v; any = true }
  return any ? out : undefined
}

export interface Provider {
  research(apiKey: string, prompt: string, fetchImpl?: typeof fetch): Promise<ResearchResult>
  // Short plain answer with no tools (used for the contradiction check). Optional so test doubles can omit it.
  complete?(apiKey: string, prompt: string, fetchImpl?: typeof fetch, maxTokens?: number): Promise<string>
  // Same call with the usage accounting kept. Optional so test doubles can omit it.
  completeDetailed?(apiKey: string, prompt: string, fetchImpl?: typeof fetch, maxTokens?: number): Promise<DetailedCompletion>
  // The model a completion request would ASK for (env override or default). The
  // response's own model field is the served model - record both, never conflate.
  configuredModel?(): string
}

const TIMEOUT_MS = Number(process.env.SCAN_LLM_TIMEOUT_MS || 150_000)

// Statuses the vendors document as REJECTED requests: Anthropic https://docs.anthropic.com/en/api/errors (400 invalid_request_error, 401
// authentication_error, 403 permission_error, 404 not_found_error, 413 request_too_large, 429 rate_limit_error) and OpenAI
// https://developers.openai.com/api/docs/guides/error-codes (400, 401, 403, 404, 429). Neither page states that a rejected request is not billed,
// so this list is a reviewed ASSUMPTION about what a rejection means, not a vendor guarantee. Everything else (402, 408, 409, 422, 425, 499,
// any 5xx, any unlisted 4xx) is uncertain and fails the scan closed.
const DECLINED_STATUS: ReadonlySet<number> = new Set([400, 401, 403, 404, 413, 429])
async function post(url: string, headers: Record<string, string>, body: unknown, fetchImpl: typeof fetch) {
  let res: Response
  try {
    res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch {
    throw new ProviderError('retry', 'network_or_timeout')
  }
  if (res.status === 401 || res.status === 403) throw new ProviderError('auth', 'key_rejected', 'rejected', res.status)
  if (!res.ok) throw new ProviderError('retry', `provider_${res.status}`, DECLINED_STATUS.has(res.status) ? 'rejected' : 'uncertain', res.status)
  try {
    return (await res.json()) as Record<string, unknown>
  } catch {
    throw new ProviderError('retry', 'bad_response')
  }
}

import { SpendRefused } from './spend-guard.ts'
import { modelCostUsd, reserveScanSpend, servedCostUsd, type SpendHold } from '../scan/spend-cap.ts'

// Inside a scan (lib/scan/spend-cap.ts): the completion's worst case is reserved on the scan's ledger before the request,
// and moved to the cost the vendor reported for the served model after it. A request that fails keeps its worst case.
async function settleScanSpend(hold: SpendHold | null, d: DetailedCompletion): Promise<void> {
  if (hold) await hold.settle(servedCostUsd(d.model, d.usage))
}

type Obj = Record<string, unknown>
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v as Obj[]) : [])

export const anthropicProvider: Provider = {
  // RETIRED (#379): the model's own web search can never run priced - its search-result tokens are bounded by
  // nothing dazl sends, so no estimate, reserve or ledger can cover it. Every budget form already refused it
  // ('research_unbounded'); the method now refuses unconditionally at the provider boundary, before any network
  // call, so no run - guarded or not, discovery or CSV - can silently make an unpriced, unbounded, unrecorded call.
  // The refusal is a SpendRefused, surfacing as an honest budget_stopped finish.
  async research(_apiKey, _prompt, _fetchImpl = fetch) {
    throw new SpendRefused('research_unbounded')
  },
  configuredModel() {
    return process.env.DAZL_ANTHROPIC_MODEL || 'claude-sonnet-4-5'
  },
  async completeDetailed(apiKey, prompt, fetchImpl = fetch, maxTokens = 10): Promise<DetailedCompletion> {
    const requested = anthropicProvider.configuredModel!()
    const hold = await reserveScanSpend('llm.anthropic', () => modelCostUsd(requested, prompt, maxTokens))
    let json: Record<string, unknown>
    try {
      json = await post(
        'https://api.anthropic.com/v1/messages',
        { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        { model: requested, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] },
        fetchImpl,
      )
    } catch (e) { if (e instanceof ProviderError && e.charge !== 'uncertain') await hold?.settle(null); else hold?.uncertain(); throw e } // an uncertain failure leaves its row 'reserved': maybe billed, never re-run automatically
    const u = (json.usage ?? {}) as Obj
    const num = (v: unknown) => (typeof v === 'number' ? v : undefined)
    const out: DetailedCompletion = {
      text: arr(json.content).map(b => (b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join(''),
      model: typeof json.model === 'string' ? json.model : null,
      request_id: typeof json.id === 'string' ? json.id : undefined,
      usage: usageOf({ input_tokens: num(u.input_tokens), output_tokens: num(u.output_tokens), cache_read_input_tokens: num(u.cache_read_input_tokens), cache_creation_input_tokens: num(u.cache_creation_input_tokens) }),
    }
    await settleScanSpend(hold, out)
    return out
  },
  async complete(apiKey, prompt, fetchImpl = fetch, maxTokens = 10) {
    return (await anthropicProvider.completeDetailed!(apiKey, prompt, fetchImpl, maxTokens)).text
  },
}

export const openaiProvider: Provider = {
  // RETIRED (#379): the model's own web search can never run priced - its search-result tokens are bounded by
  // nothing dazl sends, so no estimate, reserve or ledger can cover it. Every budget form already refused it
  // ('research_unbounded'); the method now refuses unconditionally at the provider boundary, before any network
  // call, so no run - guarded or not, discovery or CSV - can silently make an unpriced, unbounded, unrecorded call.
  // The refusal is a SpendRefused, surfacing as an honest budget_stopped finish.
  async research(_apiKey, _prompt, _fetchImpl = fetch) {
    throw new SpendRefused('research_unbounded')
  },
  configuredModel() {
    return process.env.DAZL_OPENAI_MODEL || 'gpt-4.1'
  },
  async completeDetailed(apiKey, prompt, fetchImpl = fetch, maxTokens = 16): Promise<DetailedCompletion> {
    const requested = openaiProvider.configuredModel!()
    const hold = await reserveScanSpend('llm.openai', () => modelCostUsd(requested, prompt, maxTokens))
    let json: Record<string, unknown>
    try { json = await post('https://api.openai.com/v1/responses', { authorization: `Bearer ${apiKey}` }, { model: requested, input: prompt, max_output_tokens: maxTokens }, fetchImpl) }
    catch (e) { if (e instanceof ProviderError && e.charge !== 'uncertain') await hold?.settle(null); else hold?.uncertain(); throw e }
    let text = ''
    for (const item of arr(json.output)) if (item.type === 'message') for (const part of arr(item.content)) if (part.type === 'output_text' && typeof part.text === 'string') text += part.text
    const u = (json.usage ?? {}) as Obj
    const det = (u.input_tokens_details ?? {}) as Obj
    const num = (v: unknown) => (typeof v === 'number' ? v : undefined)
    const out: DetailedCompletion = {
      text,
      model: typeof json.model === 'string' ? json.model : null,
      request_id: typeof json.id === 'string' ? json.id : undefined,
      usage: usageOf({ input_tokens: num(u.input_tokens), output_tokens: num(u.output_tokens), cache_read_input_tokens: num(det.cached_tokens) }),
    }
    await settleScanSpend(hold, out)
    return out
  },
  async complete(apiKey, prompt, fetchImpl = fetch, maxTokens = 16) {
    return (await openaiProvider.completeDetailed!(apiKey, prompt, fetchImpl, maxTokens)).text
  },
}

export const providers: Record<Vendor, Provider> = { anthropic: anthropicProvider, openai: openaiProvider }
