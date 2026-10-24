// Grade-only qualification of a saved lead. NOT wired to any route or button.
// Three separate judgments, each allowed to be "unknown", each backed by a quote that must
// appear verbatim in the page text we supplied. A hiring title alone never answers any of them.
// One request, no tools, no retry. The call refuses to run unless the caller passes an explicit
// approval object; cost figures are estimates, never a guaranteed cap.
import type { Provider } from '@/lib/llm/provider'

export type FitVerdict = 'yes' | 'no' | 'unknown'
export type BuyVerdict = 'stated' | 'none_seen' | 'unknown'
export interface Judgment<V> { verdict: V; quote: string | null; note: string }
export interface Qualification {
  company_fit: Judgment<FitVerdict>
  use_case: Judgment<FitVerdict>
  buying_evidence: Judgment<BuyVerdict>
}
export interface QualifyInput {
  seller_offer: string
  seller_icp: string
  company: string
  signal: string
  pages: { url: string; text: string }[]
}
export interface QualifyLimits { max_input_chars: number; max_output_tokens: number }
export const DEFAULT_LIMITS: QualifyLimits = { max_input_chars: 12000, max_output_tokens: 600 }
// Estimates only. Provider price list for the default model as read on 2026-10-23; the served model can differ.
export const PRICE_ESTIMATE = { input_per_mtok: 3, output_per_mtok: 15, source: 'https://platform.claude.com/docs/en/about-claude/pricing' }

export function buildQualifyPrompt(i: QualifyInput, limits: QualifyLimits = DEFAULT_LIMITS): string {
  let budget = Math.max(0, limits.max_input_chars)
  const pages = i.pages.map(p => { const t = p.text.slice(0, Math.max(0, Math.min(budget, 4000))); budget -= t.length; return { url: p.url, text: t } }).filter(p => p.text.length > 0)
  return `You judge whether ONE company could use a seller's product, using ONLY the page text below.
Seller offer: ${i.seller_offer}
Seller target profile: ${i.seller_icp}
Company: ${i.company}
Why it was saved: ${i.signal} (a hiring signal only; it is not buying intent or fit)

Judge three things separately. "unknown" is a correct answer whenever the text does not show it.
1. company_fit (yes/no/unknown): does the text show the company matches the seller's target profile? Do not assume anything the profile leaves open.
2. use_case (yes/no/unknown): does the text show a way this company's OWN team could use the seller's offer? The company's customers do not count.
3. buying_evidence (stated/none_seen/unknown): does the text explicitly show the company is looking for or evaluating this kind of product? A job posting does not count. Use none_seen only when the text covers the topic and says nothing.
Every verdict other than unknown/none_seen needs a quote copied exactly from the text.

Reply with one JSON object and nothing else:
{"company_fit":{"verdict":"","quote":"","note":""},"use_case":{"verdict":"","quote":"","note":""},"buying_evidence":{"verdict":"","quote":"","note":""}}

PAGE TEXT
${pages.map(p => `--- ${p.url}\n${p.text}`).join('\n')}`
}

export function estimateCost(prompt: string, limits: QualifyLimits = DEFAULT_LIMITS) {
  const bytes = Buffer.byteLength(prompt, 'utf8')
  // Estimate: bytes is a loose ceiling on tokens under byte-level tokenizers; not provider-confirmed.
  const input_tokens_estimate_max = bytes
  const usd = (input_tokens_estimate_max * PRICE_ESTIMATE.input_per_mtok + limits.max_output_tokens * PRICE_ESTIMATE.output_per_mtok) / 1e6
  return { chars: prompt.length, bytes, input_tokens_estimate_max, output_tokens_max: limits.max_output_tokens, usd_estimate_max: Math.round(usd * 1e6) / 1e6, is_guaranteed_cap: false as const, price_source: PRICE_ESTIMATE.source }
}

const UNKNOWN = (why: string): Qualification => ({
  company_fit: { verdict: 'unknown', quote: null, note: why }, use_case: { verdict: 'unknown', quote: null, note: why }, buying_evidence: { verdict: 'unknown', quote: null, note: why } })

function norm(s: string) { return s.replace(/\s+/g, ' ').trim() }

// Parse, then drop any verdict whose quote is not verbatim in the supplied text.
export function parseQualification(raw: string, pages: { text: string }[]): Qualification {
  const m = /\{[\s\S]*\}/.exec(raw)
  if (!m) return UNKNOWN('model output was not readable')
  let j: Record<string, { verdict?: unknown; quote?: unknown; note?: unknown }>
  try { j = JSON.parse(m[0]) } catch { return UNKNOWN('model output was not readable') }
  const hay = norm(pages.map(p => p.text).join(' \n '))
  const one = <V extends string>(k: string, ok: readonly V[], none: V): Judgment<V> => {
    const x = j[k] ?? {}
    const v = typeof x.verdict === 'string' && (ok as readonly string[]).includes(x.verdict) ? (x.verdict as V) : none
    const q = typeof x.quote === 'string' ? norm(x.quote) : ''
    const note = typeof x.note === 'string' ? x.note.slice(0, 300) : ''
    const needsQuote = v !== none && v !== ('none_seen' as string)
    if (needsQuote && (q.length < 8 || !hay.includes(q))) return { verdict: none, quote: null, note: 'dropped: the quoted text was not found in the supplied pages' }
    return { verdict: v, quote: needsQuote ? q : null, note }
  }
  return {
    company_fit: one<FitVerdict>('company_fit', ['yes', 'no', 'unknown'], 'unknown'),
    use_case: one<FitVerdict>('use_case', ['yes', 'no', 'unknown'], 'unknown'),
    buying_evidence: one<BuyVerdict>('buying_evidence', ['stated', 'none_seen', 'unknown'], 'unknown'),
  }
}

export interface PaidApproval { approved_by_user: true; max_usd_estimate: number }
export type QualifyResult =
  | { status: 'dry_run'; cost: ReturnType<typeof estimateCost> }
  | { status: 'blocked'; reason: 'no_approval' | 'over_estimate' | 'no_pages' | 'no_provider'; cost?: ReturnType<typeof estimateCost> }
  | { status: 'done'; qualification: Qualification; cost: ReturnType<typeof estimateCost>; usage?: unknown; served_model: string | null }

// Exactly one provider request. No retry. Without `approval` it only reports the estimate.
export async function qualifyLead(provider: Provider, apiKey: string, input: QualifyInput, opts: { limits?: QualifyLimits; approval?: PaidApproval; fetchImpl?: typeof fetch } = {}): Promise<QualifyResult> {
  const limits = opts.limits ?? DEFAULT_LIMITS
  if (!input.pages.some(p => p.text.trim().length > 0)) return { status: 'blocked', reason: 'no_pages' }
  const prompt = buildQualifyPrompt(input, limits)
  const cost = estimateCost(prompt, limits)
  if (!opts.approval) return { status: 'dry_run', cost }
  if (opts.approval.approved_by_user !== true) return { status: 'blocked', reason: 'no_approval', cost }
  if (cost.usd_estimate_max > opts.approval.max_usd_estimate) return { status: 'blocked', reason: 'over_estimate', cost }
  if (!provider.completeDetailed) return { status: 'blocked', reason: 'no_provider', cost }
  const used = input.pages.map(p => ({ text: p.text.slice(0, 4000) }))
  const r = await provider.completeDetailed(apiKey, prompt, opts.fetchImpl, limits.max_output_tokens)
  return { status: 'done', qualification: parseQualification(r.text, used), cost, usage: r.usage, served_model: r.model }
}
