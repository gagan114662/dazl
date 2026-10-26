// Verification provenance (diagnostic only, changes no verdict). Instinct's condition for ever verifying a quote
// against the text TinyFish already fetched: first show that TinyFish really had text for the pages the verifier
// could not read. This records, per scan, for every candidate's cited URL: did TinyFish return page text for it,
// and what did the verifier's own fetch get. One JSON line in the server log, tagged verify_provenance.
import type { FetchFail, Page } from './fetch-page.ts'
import { canonicalUrl } from '../search/tinyfish.ts'

export type FetchOutcome = 'ok' | FetchFail['fail'] | 'null'
const canon = (u: string) => canonicalUrl(u) ?? u

// Wraps the verifier's page fetcher and remembers the outcome per URL. The result passes through untouched.
export function recordingFetcher(inner: (url: string) => Promise<Page | FetchFail | null>, seen: Map<string, FetchOutcome>) {
  return async (url: string) => {
    const r = await inner(url)
    seen.set(canon(url), !r ? 'null' : 'fail' in r ? r.fail : 'ok')
    return r
  }
}

export interface ProvenanceSummary {
  candidates: number
  verifier: Record<string, number>                 // verifier fetch outcome -> count
  verifier_failed_tinyfish_had_text: number        // the case reuse would rescue
  verifier_failed_no_tinyfish_text: number         // reuse would NOT help: source selection is the fix
  verifier_ok_tinyfish_had_text: number
  verifier_not_fetched: number
}

export function summarizeProvenance(candidateUrls: string[], tinyfishText: Set<string>, seen: Map<string, FetchOutcome>): ProvenanceSummary {
  const s: ProvenanceSummary = { candidates: 0, verifier: {}, verifier_failed_tinyfish_had_text: 0, verifier_failed_no_tinyfish_text: 0, verifier_ok_tinyfish_had_text: 0, verifier_not_fetched: 0 }
  const tf = new Set([...tinyfishText].map(canon))
  for (const raw of new Set(candidateUrls.map(canon))) {
    s.candidates++
    const o = seen.get(raw)
    if (!o) { s.verifier_not_fetched++; continue }
    s.verifier[o] = (s.verifier[o] ?? 0) + 1
    if (o === 'ok') { if (tf.has(raw)) s.verifier_ok_tinyfish_had_text++ }
    else if (tf.has(raw)) s.verifier_failed_tinyfish_had_text++
    else s.verifier_failed_no_tinyfish_text++
  }
  return s
}
