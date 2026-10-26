// Verification provenance (diagnostic only, changes no verdict). Instinct's condition for ever verifying a quote
// against the text TinyFish already fetched: first show that TinyFish really had text for the pages the verifier
// could not read. This records, per scan, for every candidate's cited URL (freshness retry included): did TinyFish
// return page text for it, and what did the verifier's own fetch get. One JSON line in the server log, tagged
// verify_provenance.
// What the counts do NOT say: "TinyFish had text" is potential fetch coverage only. The same text could still fail the
// quote, company, date or consent checks, so it is never a count of leads that reuse would rescue.
import type { FetchFail, Page } from './fetch-page.ts'
import { canonicalUrl } from '../search/tinyfish.ts'

export type FetchOutcome = 'ok' | FetchFail['fail'] | 'null' | 'threw'
const canon = (u: string) => canonicalUrl(u) ?? u

// Wraps the verifier's page fetcher and remembers the outcome per URL. Results pass through untouched; a throw is
// recorded as 'threw' and rethrown unchanged, so the caller behaves exactly as without the wrapper.
export function recordingFetcher(inner: (url: string) => Promise<Page | FetchFail | null>, seen: Map<string, FetchOutcome>) {
  return async (url: string) => {
    let r: Page | FetchFail | null
    try { r = await inner(url) } catch (e) { seen.set(canon(url), 'threw'); throw e }
    seen.set(canon(url), !r ? 'null' : 'fail' in r ? r.fail : 'ok')
    return r
  }
}

export interface ProvenanceSummary {
  candidates: number
  verifier: Record<string, number>                        // verifier fetch outcome -> count ('threw' = the fetch raised)
  verifier_failed_tinyfish_had_text_potential: number     // potential fetch coverage only, NOT a confirmed rescue
  verifier_failed_no_tinyfish_text: number                // reuse could not help: source selection is the fix
  verifier_ok_tinyfish_had_text: number
  verifier_not_fetched: number
}

export function summarizeProvenance(candidateUrls: string[], tinyfishText: Set<string>, seen: Map<string, FetchOutcome>): ProvenanceSummary {
  const s: ProvenanceSummary = { candidates: 0, verifier: {}, verifier_failed_tinyfish_had_text_potential: 0, verifier_failed_no_tinyfish_text: 0, verifier_ok_tinyfish_had_text: 0, verifier_not_fetched: 0 }
  const tf = new Set([...tinyfishText].map(canon))
  for (const raw of new Set(candidateUrls.map(canon))) {
    s.candidates++
    const o = seen.get(raw)
    if (!o) { s.verifier_not_fetched++; continue }
    s.verifier[o] = (s.verifier[o] ?? 0) + 1
    if (o === 'ok') { if (tf.has(raw)) s.verifier_ok_tinyfish_had_text++ }
    else if (tf.has(raw)) s.verifier_failed_tinyfish_had_text_potential++
    else s.verifier_failed_no_tinyfish_text++
  }
  return s
}
