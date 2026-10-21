import type { Vendor } from './vendors.ts'

// A research call: the model searches the web and answers. Each vendor's own
// web-search tool is used, so the cost lands on the tenant's own key.
export interface ResearchResult {
  text: string
  // URLs the vendor actually returned from search or cited. Leads may only cite these.
  citedUrls: string[]
}

export class ProviderError extends Error {
  // 'auth': key rejected (do not retry). 'retry': timeout, 429, 5xx, bad output.
  kind: 'auth' | 'retry'
  constructor(kind: 'auth' | 'retry', message: string) {
    super(message)
    this.kind = kind
  }
}

export interface Provider {
  research(apiKey: string, prompt: string, fetchImpl?: typeof fetch): Promise<ResearchResult>
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
    return { text, citedUrls: [...urls] }
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
}

export const providers: Record<Vendor, Provider> = { anthropic: anthropicProvider, openai: openaiProvider }
