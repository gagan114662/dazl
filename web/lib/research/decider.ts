// MISSION v2 (research engine), part C. The free typed-decision model: OpenRouter's perplexity/pplx-decider-v1.3:free at POST /api/alpha/decisions.
// Ported from ~/work/proto/ai-research/lib.py `decide`. It answers typed questions about a small JSON "state": `noul` = probability (0-1) that the answer is yes,
// `choice` = one option key. Response shape (recorded 2026-11-15 from this PC, cost 0):
//   { model, answers: { <key>: { type: 'noul', noul: 0.99 } | { type: 'choice', choice: 'news', probabilities: {...}, confidence } }, usage: { cost: 0, ... } }
// Free, so it is used on every search result; when it is unreachable or rate-limited the caller falls back to a paid model (filter.ts, gate.ts).
// The key is OPENROUTER_API_KEY (set on staging); it is never logged.

export type Question = { type: 'noul'; instructions: string } | { type: 'choice'; instructions: string; criteria: Record<string, string> }
export type Answers = Record<string, number | string | null>
export const DECIDER_URL = 'https://openrouter.ai/api/alpha/decisions'
export const DECIDER_MODEL = 'perplexity/pplx-decider-v1.3:free'

export interface DeciderDeps {
  apiKey?: string
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  timeoutMs?: number
}

// One decider per scan. After `maxFailures` consecutive calls that end without an answer (network error, 5xx, 429 after retries) it marks itself down and
// every later call returns null at once, so a blocked or exhausted free tier never costs a scan minutes of retries (the prototype lost OpenRouter mid-run).
export class Decider {
  up: boolean
  calls = 0
  answered = 0
  private fails = 0
  private deps: DeciderDeps
  private maxFailures: number
  constructor(deps: DeciderDeps = {}, maxFailures = 3) { this.deps = deps; this.maxFailures = maxFailures; this.up = !!(deps.apiKey ?? process.env.OPENROUTER_API_KEY) }

  async decide(state: Record<string, unknown>, questions: Record<string, Question>): Promise<Answers | null> {
    if (!this.up) return null
    const key = this.deps.apiKey ?? process.env.OPENROUTER_API_KEY ?? ''
    const f = this.deps.fetchImpl ?? fetch
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
    for (let attempt = 0; attempt < 3; attempt++) {
      this.calls++
      let res: Response
      try {
        res = await f(DECIDER_URL, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: DECIDER_MODEL, state, questions }), signal: AbortSignal.timeout(this.deps.timeoutMs ?? 40_000) })
      } catch { return this.failed() }   // network error or timeout: no retry here, the next call may succeed
      if (res.status === 429) { await sleep(3000 * (attempt + 1)); continue }
      if (res.status !== 200) return this.failed()
      const parsed = parseAnswers(await res.json().catch(() => null), questions)
      if (!parsed) return this.failed()
      this.fails = 0; this.answered++
      return parsed
    }
    return this.failed()
  }
  private failed(): null { if (++this.fails >= this.maxFailures) this.up = false; return null }
}

// Keeps only the answers that match the asked type: a noul in [0, 1], a choice among the offered keys. Anything else is missing (null), never guessed.
export function parseAnswers(body: unknown, questions: Record<string, Question>): Answers | null {
  const answers = body && typeof body === 'object' ? (body as { answers?: unknown }).answers : null
  if (!answers || typeof answers !== 'object') return null
  const out: Answers = {}
  for (const [k, q] of Object.entries(questions)) {
    const a = (answers as Record<string, unknown>)[k] as Record<string, unknown> | undefined
    if (q.type === 'noul') { const v = a?.noul; out[k] = typeof v === 'number' && v >= 0 && v <= 1 ? v : null }
    else { const v = a?.choice; out[k] = typeof v === 'string' && Object.hasOwn(q.criteria, v) ? v : null }
  }
  return out
}

// A model reply that should be JSON, possibly inside a ```json fence or with prose around it. Null when there is no parseable object.
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const s = text.indexOf('{'), e = text.lastIndexOf('}')
  if (s < 0 || e <= s) return null
  try { const v = JSON.parse(text.slice(s, e + 1)); return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null } catch { return null }
}

// Bounded concurrency, order kept.
export async function pmap<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let next = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i) } }))
  return out
}
