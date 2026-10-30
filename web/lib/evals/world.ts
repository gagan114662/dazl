// Worlds (docs/design/agent-evals.md): a frozen snapshot of everything outside dazl that one agent run saw - search
// results, TinyFish page text, the verifier's own page fetches, source-adapter HTTP and the model's replies - so the
// run can be replayed offline against an isolated copy (./replay.ts). A World is DATA ONLY: it holds no expected
// outcome (that is the case's job, ./case.ts) and no credential.
//
// A World comes from a trace (worldFromTrace) or is written by hand (origin 'synthetic'). A trace of a real run is
// refused unless it was redacted first (./redact.ts): a recorded World is stored, so it must never hold raw PII.
import type { FetchFail } from '../scan/fetch-page.ts'
import type { HttpResult } from '../sources/types.ts'
import type { Trace } from './trace.ts'

export const WORLD_VERSION = 1
export interface WorldHit { url: string; title: string; snippet: string; date?: string | null }
export type WorldPage = { title: string; text: string; published?: string | null; structured?: string[] } | { fail: FetchFail['fail'] } | { unreachable: true } | { threw: string }
export interface WorldReply { method: 'complete' | 'completeDetailed' | 'research'; text: string; model?: string | null; usage?: { input_tokens?: number; output_tokens?: number } | null; cited_urls?: string[]; error?: string }
export interface World {
  v: typeof WORLD_VERSION; kind: 'dazl.world'; id: string
  origin: 'synthetic' | 'recorded'
  redacted: boolean
  as_of: string                              // ISO instant the snapshot was taken; the replay clock is frozen here
  from_trace?: string
  note?: string
  search: {
    by_query: Record<string, WorldHit[] | { status: number }>   // exact query string as sent
    default?: WorldHit[]                     // synthetic worlds only: the answer to any query not listed (people search excepted, below)
  }
  tinyfish_pages: Record<string, { title: string; text: string }>
  pages: Record<string, WorldPage>           // the verifier's own fetch, by exact URL
  http: Record<string, HttpResult | null>    // every other HTTP call (source adapters via SafeGet, enrichment via fetch), by exact URL; null = the call failed
  http_default?: HttpResult                  // synthetic worlds only: the answer to any URL not listed ("the outside world has nothing")
  model: Record<string, WorldReply[]>        // by replayStage(prompt); consumed in order, a call past the end is a world miss
}

export class WorldError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

// Structural check only; throws WorldError naming the first problem. Run on every World before it is replayed.
export function validateWorld(w: unknown): World {
  if (!isObj(w)) throw new WorldError('world: not an object')
  if (w.kind !== 'dazl.world') throw new WorldError('world: kind must be dazl.world')
  if (w.v !== WORLD_VERSION) throw new WorldError(`world: unsupported version ${String(w.v)}`)
  if (typeof w.id !== 'string' || !w.id) throw new WorldError('world: id required')
  if (w.origin !== 'synthetic' && w.origin !== 'recorded') throw new WorldError('world: origin must be synthetic or recorded')
  if (w.origin === 'recorded' && w.redacted !== true) throw new WorldError('world: a recorded world must be redacted')
  if (typeof w.as_of !== 'string' || Number.isNaN(Date.parse(w.as_of))) throw new WorldError('world: as_of must be an ISO date')
  if (!isObj(w.search) || !isObj(w.search.by_query)) throw new WorldError('world: search.by_query required')
  if (w.origin === 'recorded' && (w.search.default !== undefined || w.http_default !== undefined)) throw new WorldError('world: a recorded world answers only the calls it saw (no search.default / http_default)')
  for (const k of ['tinyfish_pages', 'pages', 'http', 'model'] as const) if (!isObj(w[k])) throw new WorldError(`world: ${k} must be an object`)
  for (const [stage, rs] of Object.entries(w.model as Record<string, unknown>)) {
    if (!Array.isArray(rs)) throw new WorldError(`world: model.${stage} must be a list`)
    for (const r of rs) if (!isObj(r) || typeof r.text !== 'string') throw new WorldError(`world: model.${stage} reply needs text`)
  }
  return w as unknown as World
}

const parse = (s: unknown): unknown => { try { return typeof s === 'string' ? JSON.parse(s) : null } catch { return null } }

// Freezes what a trace's spans saw into a World. Spans that errored are kept as errors (a page fetch that threw replays
// as a throw), so the replay meets the same failures the run met. A real (non-synthetic) trace must be redacted first.
export function worldFromTrace(t: Trace, id = `world-${t.id}`): World {
  if (t.synthetic_defaults && !t.synthetic) throw new WorldError('world: only a synthetic trace may carry synthetic_defaults')
  if (!t.synthetic && !t.redacted) throw new WorldError('world: refusing an unredacted trace of a real run (redact it first)')
  const w: World = { v: WORLD_VERSION, kind: 'dazl.world', id, origin: t.synthetic ? 'synthetic' : 'recorded', redacted: t.redacted, as_of: t.input.as_of, from_trace: t.id, search: { by_query: {} }, tinyfish_pages: {}, pages: {}, http: {}, model: {}, ...(t.synthetic_defaults?.http ? { http_default: t.synthetic_defaults.http } : {}) }
  for (const s of t.spans) {
    const inp = s.input as Record<string, unknown>
    if (s.kind === 'http' && s.name === 'tinyfish.search') {
      const q = new URL(String(inp.url)).searchParams.get('query') ?? ''
      const out = s.output as { status: number; body: string | null } | null
      if (!out) continue
      const results = (parse(out.body) as { results?: WorldHit[] } | null)?.results
      w.search.by_query[q] = out.status === 200 && Array.isArray(results) ? results.map(h => ({ url: h.url, title: h.title, snippet: h.snippet, ...(h.date ? { date: h.date } : {}) })) : { status: out.status }
    } else if (s.kind === 'http' && s.name === 'http') {
      const out = s.output as { status: number; body: string | null } | null
      w.http[String(inp.url)] = s.error || !out ? null : { status: out.status, body: out.body ?? '' }
    } else if (s.kind === 'http' && s.name === 'tinyfish.fetch') {
      const out = s.output as { status: number; body: string | null } | null
      for (const r of ((parse(out?.body) as { results?: { url: string; title: string; text: string }[] } | null)?.results ?? [])) w.tinyfish_pages[r.url] = { title: r.title, text: r.text }
    } else if (s.kind === 'page') {
      const url = String(inp.url)
      const o = s.output as Record<string, unknown> | null
      w.pages[url] = s.error ? { threw: s.error } : !o ? { unreachable: true } : 'fail' in o ? { fail: o.fail as FetchFail['fail'] } : { title: String(o.title ?? ''), text: String(o.text ?? ''), ...(o.published ? { published: String(o.published) } : {}), ...(Array.isArray(o.structured) ? { structured: o.structured as string[] } : {}) }
    } else if (s.kind === 'source_http') {
      w.http[String(inp.url)] = (s.output as HttpResult | null) ?? null
    } else if (s.kind === 'model') {
      const stage = String(inp.stage)
      const o = (s.output ?? {}) as { text?: string; model?: string | null; usage?: WorldReply['usage']; citedUrls?: string[] }
      const reply: WorldReply = { method: inp.method as WorldReply['method'], text: o.text ?? '', ...(o.model !== undefined ? { model: o.model } : {}), ...(o.usage ? { usage: o.usage } : {}), ...(o.citedUrls ? { cited_urls: o.citedUrls } : {}), ...(s.error ? { error: s.error } : {}) }
      ;(w.model[stage] ??= []).push(reply)
    }
  }
  return w
}
