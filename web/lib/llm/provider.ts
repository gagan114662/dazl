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
  constructor(kind: 'auth' | 'retry', message: string) {
    super(message)
    this.kind = kind
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

async function post(url: string, headers: Record<string, string>, body: unknown, fetchImpl: typeof fetch) {
  let res: Response
  try {
    res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch {
    throw new ProviderError('retry', 'network_or_timeout')
  }
  if (res.status === 401 || res.status === 403) throw new ProviderError('auth', 'key_rejected')
  if (!res.ok) throw new ProviderError('retry', `provider_${res.status}`)
  try {
    return (await res.json()) as Record<string, unknown>
  } catch {
    throw new ProviderError('retry', 'bad_response')
  }
}

type Obj = Record<string, unknown>
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v as Obj[]) : [])

export const anthropicProvider: Provider = {
  async research(apiKey, prompt, fetchImpl = fetch) {
    const json = await post(
      'https://api.anthropic.com/v1/messages',
      { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      {
        model: process.env.DAZL_ANTHROPIC_MODEL || 'claude-sonnet-4-5',
        max_tokens: 4096,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }],
        messages: [{ role: 'user', content: prompt }],
      },
      fetchImpl,
    )
    let text = ''
    const urls = new Set<string>()
    for (const block of arr(json.content)) {
      if (block.type === 'text' && typeof block.text === 'string') {
        text += block.text
        for (const c of arr(block.citations)) if (typeof c.url === 'string') urls.add(c.url)
      } else if (block.type === 'web_search_tool_result') {
        for (const r of arr(block.content)) if (typeof r.url === 'string') urls.add(r.url)
      }
    }
    const u = json.usage as { input_tokens?: unknown; output_tokens?: unknown; server_tool_use?: { web_search_requests?: unknown } } | undefined
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
    const usage = u ? { model: typeof json.model === 'string' ? json.model : undefined, input_tokens: num(u.input_tokens), output_tokens: num(u.output_tokens), web_search_requests: num(u.server_tool_use?.web_search_requests) } : undefined
    return { text, citedUrls: [...urls], ...(usage ? { usage } : {}) }
  },
  configuredModel() {
    return process.env.DAZL_ANTHROPIC_MODEL || 'claude-sonnet-4-5'
  },
  async completeDetailed(apiKey, prompt, fetchImpl = fetch, maxTokens = 10): Promise<DetailedCompletion> {
    const requested = anthropicProvider.configuredModel!()
    const json = await post(
      'https://api.anthropic.com/v1/messages',
      { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      { model: requested, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] },
      fetchImpl,
    )
    const u = (json.usage ?? {}) as Obj
    const num = (v: unknown) => (typeof v === 'number' ? v : undefined)
    return {
      text: arr(json.content).map(b => (b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join(''),
      model: typeof json.model === 'string' ? json.model : null,
      request_id: typeof json.id === 'string' ? json.id : undefined,
      usage: usageOf({ input_tokens: num(u.input_tokens), output_tokens: num(u.output_tokens), cache_read_input_tokens: num(u.cache_read_input_tokens), cache_creation_input_tokens: num(u.cache_creation_input_tokens) }),
    }
  },
  async complete(apiKey, prompt, fetchImpl = fetch, maxTokens = 10) {
    return (await anthropicProvider.completeDetailed!(apiKey, prompt, fetchImpl, maxTokens)).text
  },
}

export const openaiProvider: Provider = {
  async research(apiKey, prompt, fetchImpl = fetch) {
    const json = await post(
      'https://api.openai.com/v1/responses',
      { authorization: `Bearer ${apiKey}` },
      { model: process.env.DAZL_OPENAI_MODEL || 'gpt-4.1', tools: [{ type: 'web_search' }], input: prompt },
      fetchImpl,
    )
    let text = ''
    const urls = new Set<string>()
    for (const item of arr(json.output)) {
      if (item.type !== 'message') continue
      for (const part of arr(item.content)) {
        if (part.type === 'output_text' && typeof part.text === 'string') {
          text += part.text
          for (const a of arr(part.annotations)) if (a.type === 'url_citation' && typeof a.url === 'string') urls.add(a.url)
        }
      }
    }
    return { text, citedUrls: [...urls] }
  },
  configuredModel() {
    return process.env.DAZL_OPENAI_MODEL || 'gpt-4.1'
  },
  async completeDetailed(apiKey, prompt, fetchImpl = fetch, maxTokens = 16): Promise<DetailedCompletion> {
    const requested = openaiProvider.configuredModel!()
    const json = await post('https://api.openai.com/v1/responses', { authorization: `Bearer ${apiKey}` }, { model: requested, input: prompt, max_output_tokens: maxTokens }, fetchImpl)
    let text = ''
    for (const item of arr(json.output)) if (item.type === 'message') for (const part of arr(item.content)) if (part.type === 'output_text' && typeof part.text === 'string') text += part.text
    const u = (json.usage ?? {}) as Obj
    const det = (u.input_tokens_details ?? {}) as Obj
    const num = (v: unknown) => (typeof v === 'number' ? v : undefined)
    return {
      text,
      model: typeof json.model === 'string' ? json.model : null,
      request_id: typeof json.id === 'string' ? json.id : undefined,
      usage: usageOf({ input_tokens: num(u.input_tokens), output_tokens: num(u.output_tokens), cache_read_input_tokens: num(det.cached_tokens) }),
    }
  },
  async complete(apiKey, prompt, fetchImpl = fetch, maxTokens = 16) {
    return (await openaiProvider.completeDetailed!(apiKey, prompt, fetchImpl, maxTokens)).text
  },
}

export const providers: Record<Vendor, Provider> = { anthropic: anthropicProvider, openai: openaiProvider }
