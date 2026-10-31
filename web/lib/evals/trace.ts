// Agent traces (docs/design/agent-evals.md): every external call one agent run makes, as ordered spans, so the run can be
// inspected, scored, and frozen into a World for replay. Recording wraps the seams runJob already takes (RunDeps:
// providers, fetchImpl, fetchPage, sourceHttp/newsHttp); it never changes what a call returns or throws.
//
// What a span never holds: API keys (the provider's key argument is not recorded), request headers (TinyFish's key is a
// header), or anything the caller did not pass through a wrapped seam. Prompts, page text and replies ARE held, so a
// trace from a real run is PII until redact() (./redact.ts) has run on it; worldFromTrace refuses an unredacted real one.
import type { Provider, ResearchResult, DetailedCompletion } from '../llm/provider.ts'
import type { FetchFail, Page } from '../scan/fetch-page.ts'
import type { SafeGet } from '../sources/types.ts'
import { stageOfPrompt } from '../scan/model-usage.ts'
import { PRICES_USD_PER_M } from '../llm/spend-guard.ts'

export const TRACE_VERSION = 1
export type SpanKind = 'model' | 'http' | 'page' | 'source_http'
export interface Span {
  id: string; seq: number; kind: SpanKind; name: string
  start_ms: number; duration_ms: number
  input: Record<string, unknown>; output: unknown
  error?: string
  cost_usd?: number | null // model spans only: from the usage the provider reported and the listed price; null = unknown, never 0
}
export interface Trace {
  v: typeof TRACE_VERSION; kind: 'dazl.trace'; id: string
  path: 'scan.discovery'
  synthetic: boolean // true: invented by hand or produced by a replay against a synthetic World. false: a real run (PII until redacted)
  redacted: boolean
  started_at: string
  agent: { commit: string | null; label?: string }
  input: { request: string; icp?: unknown; as_of: string }
  spans: Span[]
  output?: { status: string; leads: TraceLead[] }
  // A hand-written (synthetic) trace's shorthand for "every call not listed got this", instead of one span per URL the
  // code happens to build (ATS boards, filings, feeds). Never on a real trace: a recorded World answers only what it saw.
  synthetic_defaults?: { http?: { status: number; body: string } }
  // A captured production trace (lib/evals/capture.ts) that had to be cut to fit the store says so here.
  // `complete: false` whenever anything was dropped; worldFromTrace refuses such a trace.
  capture?: { complete?: boolean; max_bytes?: number; truncated_strings?: number; bodies_truncated?: number; spans_metadata_only?: boolean; spans_omitted?: number; leads_omitted?: number; input_omitted?: boolean }
}
export interface TraceLead { company: string; name: string; contact: string | null; source_url: string; excerpt: string | null; event_date: string | null; review_reason: string | null; confidence: number | null }

// Which model reply a prompt asks for. model-usage's stage table labels the extraction template 'other', so the
// extraction opening is matched first; everything else is that table's label.
export const replayStage = (prompt: string): string => /^You turn pre-collected public items/.test(prompt) ? 'extraction' : stageOfPrompt(prompt)

// Which HTTP family a URL belongs to. Only TinyFish search/fetch become World entries; anything else is kept as a plain
// 'http' span so the replay can report it as a world miss.
export function httpName(url: string): string {
  if (url.startsWith('https://api.search.tinyfish.ai')) return 'tinyfish.search'
  if (url.startsWith('https://api.fetch.tinyfish.ai')) return 'tinyfish.fetch'
  return 'http'
}

const modelCost = (d: Pick<DetailedCompletion, 'model' | 'usage'>): number | null => {
  const p = d.model ? PRICES_USD_PER_M[d.model] : undefined
  const u = d.usage
  return p && u?.input_tokens !== undefined && u.output_tokens !== undefined ? (u.input_tokens * p.in + u.output_tokens * p.out) / 1e6 : null
}

export class TraceRecorder {
  readonly spans: Span[] = []
  private readonly t0: number
  private readonly clock: () => number
  constructor(clock: () => number = () => performance.now()) { this.clock = clock; this.t0 = clock() }

  private async span<T>(kind: SpanKind, name: string, input: Record<string, unknown>, run: () => Promise<T>, out: (r: T) => unknown, cost?: (r: T) => number | null): Promise<T> {
    const seq = this.spans.length
    const s: Span = { id: `s${seq}`, seq, kind, name, start_ms: Math.round(this.clock() - this.t0), duration_ms: 0, input, output: null }
    this.spans.push(s) // pushed before the call, so spans stay in call order even when calls overlap
    try {
      const r = await run()
      s.output = out(r)
      if (cost) s.cost_usd = cost(r)
      return r
    } catch (e) {
      s.error = e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300)
      throw e
    } finally { s.duration_ms = Math.round(this.clock() - this.t0) - s.start_ms }
  }

  // The provider's key argument is dropped; the prompt, max_tokens and the reply are recorded.
  provider(p: Provider, vendor: string): Provider {
    const w: Provider = {
      ...p,
      research: (key, prompt, f) => this.span('model', `${vendor}.research`, { stage: replayStage(prompt), method: 'research', prompt }, () => p.research(key, prompt, f), (r: ResearchResult) => r, () => null),
    }
    if (p.complete) w.complete = (key, prompt, f, max) => this.span('model', `${vendor}.complete`, { stage: replayStage(prompt), method: 'complete', prompt, max_tokens: max ?? null }, () => p.complete!.call(p, key, prompt, f, max), (r: string) => ({ text: r }), () => null)
    if (p.completeDetailed) w.completeDetailed = (key, prompt, f, max) => this.span('model', `${vendor}.completeDetailed`, { stage: replayStage(prompt), method: 'completeDetailed', prompt, max_tokens: max ?? null }, () => p.completeDetailed!.call(p, key, prompt, f, max), (r: DetailedCompletion) => ({ text: r.text, model: r.model, usage: r.usage ?? null }), modelCost)
    return w
  }

  providers<V extends string>(ps: Record<V, Provider>): Record<V, Provider> {
    return Object.fromEntries(Object.entries(ps).map(([v, p]) => [v, this.provider(p as Provider, v)])) as Record<V, Provider>
  }

  // Method, URL and body are recorded; headers are not (TinyFish's key travels in one). The caller gets the response as
  // soon as it arrives: the recorded body is read from a clone in the background, capped (bodyCap), and settled() waits
  // for it. A model provider's own API (api.anthropic.com, api.openai.com) records no bodies: its prompt and reply are
  // already in the model span, and its request body is the prompt again.
  private readonly pending: Promise<unknown>[] = []
  fetch(inner: typeof fetch, bodyCap: (name: string, url: string) => number = name => name.startsWith('tinyfish.') ? 4_000_000 : 200_000): typeof fetch {
    return ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input)
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
      const provider = /^https:\/\/api\.(anthropic|openai)\.com\//.test(url)
      const name = httpName(url)
      const body = !provider && typeof init?.body === 'string' ? init.body : null
      return this.span('http', name, { method, url, body }, () => inner(input as never, init), res => {
        const out: { status: number; body: string | null; truncated?: boolean } = { status: res.status, body: null }
        if (!provider) this.pending.push(readCapped(res.clone(), bodyCap(name, url), this.readers).then(r => { out.body = r.text; if (r.truncated) out.truncated = true }, () => { out.truncated = true /* unreadable: body stays null, and the span says it is incomplete */ }))
        return out
      })
    }) as typeof fetch
  }
  // Every background body read has finished, failed or (after `ms`) been cancelled: a body that never ends keeps what was
  // read and is closed, so no stream or connection outlives the run. Call before reading spans.
  private readonly readers = new Set<ReadableStreamDefaultReader<Uint8Array>>()
  async settled(ms = Infinity): Promise<void> {
    let t: ReturnType<typeof setTimeout> | undefined
    const all = Promise.allSettled(this.pending)
    const timedOut = await (Number.isFinite(ms) ? Promise.race([all.then(() => false), new Promise<boolean>(r => { t = setTimeout(() => r(true), ms) })]) : all.then(() => false))
    clearTimeout(t)
    if (timedOut) { for (const r of this.readers) void r.cancel().catch(() => { /* best effort */ }); this.readers.clear(); await all }
  }

  pageFetcher(inner: (url: string) => Promise<Page | FetchFail | null>): (url: string) => Promise<Page | FetchFail | null> {
    return url => this.span('page', 'verifier.fetch', { url }, () => inner(url), r => r)
  }

  safeGet(inner: SafeGet, name: string): SafeGet {
    return (url, opts) => this.span('source_http', name, { url, accept: opts?.accept ?? null }, () => inner(url, opts), r => r)
  }
}

// Reads at most `cap` characters of a response body, then cancels the rest of the stream. The reader is registered in
// `live` while it runs, so TraceRecorder.settled can cancel it; a cancelled read keeps what it had and is marked truncated.
async function readCapped(res: Response, cap: number, live: Set<ReadableStreamDefaultReader<Uint8Array>>): Promise<{ text: string | null; truncated: boolean }> {
  if (!res.body) return { text: await res.text(), truncated: false }
  const reader = res.body.getReader(); const dec = new TextDecoder()
  live.add(reader)
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return live.has(reader) ? { text: text + dec.decode(), truncated: false } : { text, truncated: true }
      text += dec.decode(value, { stream: true })
      if (text.length > cap) { void reader.cancel().catch(() => { /* best effort */ }); return { text: text.slice(0, cap), truncated: true } }
    }
  } catch { return { text: text || null, truncated: true } } finally { live.delete(reader) }
}

export function totals(t: Pick<Trace, 'spans'>): { spans: number; model_calls: number; http_calls: number; page_fetches: number; errors: number; cost_usd: number | null; cost_complete: boolean; duration_ms: number } {
  const model = t.spans.filter(s => s.kind === 'model')
  const priced = model.filter(s => typeof s.cost_usd === 'number')
  return {
    spans: t.spans.length,
    model_calls: model.length,
    http_calls: t.spans.filter(s => s.kind === 'http' || s.kind === 'source_http').length,
    page_fetches: t.spans.filter(s => s.kind === 'page').length,
    errors: t.spans.filter(s => s.error).length,
    cost_usd: priced.length ? priced.reduce((a, s) => a + (s.cost_usd as number), 0) : null, // null when no call had a price: unknown, not free
    cost_complete: priced.length === model.length,
    duration_ms: t.spans.reduce((a, s) => Math.max(a, s.start_ms + s.duration_ms), 0),
  }
}
