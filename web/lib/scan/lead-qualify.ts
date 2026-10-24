// Grade-only qualification of a saved lead. NOT wired to any route or button.
// Three separate judgments, each allowed to be "unknown", each backed by a quote that must
// appear verbatim in the page text we supplied. A hiring title alone never answers any of them.
// One request, no tools, no retry. The call refuses to run unless the caller passes an explicit
// approval object; cost figures are estimates, never a guaranteed cap.
import { createHash } from 'node:crypto'
import type { Provider } from '@/lib/llm/provider'

export type FitVerdict = 'yes' | 'no' | 'unknown'
export type BuyVerdict = 'stated' | 'none_seen' | 'unknown'
export type PageRole = 'posting' | 'company_home'
// Why a model verdict was dropped. Only conditions the guard itself checked: no semantic reason is guessed.
export type RejectReason = 'quote_missing' | 'too_short' | 'url_not_sent' | 'not_on_page'
export interface Rejection {
  reason: RejectReason
  model_verdict: string          // the verdict the model returned, shown as unverified
  quote_chars: number            // length of the normalised quote; the quote itself is never stored
  named_page_truncated: boolean | null // whether the page the model named was cut off; null when no sent page was named
  model_note: string             // model-authored, untrusted, bounded; never evidence
}
export interface Judgment<V> { verdict: V; quote: string | null; quote_url: string | null; quote_role: PageRole | null; note: string; rejected?: Rejection }
export interface EvidenceScope { pages_included: { url: string; role?: PageRole; chars_sent: number; chars_available: number; truncated: boolean }[]; pages_omitted: string[]; any_truncated: boolean }
export interface Qualification {
  company_fit: Judgment<FitVerdict>
  use_case: Judgment<FitVerdict>
  buying_evidence: Judgment<BuyVerdict>
  // none_seen and unknown only describe these pages as sent. They never claim the company shows nothing elsewhere.
  evidence_scope: EvidenceScope
  // Must accompany every verdict wherever it is shown.
  caveat: string
}
export interface QualifyInput {
  seller_offer: string
  seller_icp: string
  company: string
  signal: string
  pages: { url: string; text: string; role?: PageRole }[]
}
export interface QualifyLimits { max_input_chars: number; max_page_chars: number; max_output_tokens: number }
export const DEFAULT_LIMITS: QualifyLimits = { max_input_chars: 12000, max_page_chars: 4000, max_output_tokens: 600 }
// Fixed caps on the non-page fields so the whole prompt is bounded, not just the pages.
export const FIELD_CAPS = { seller_offer: 300, seller_icp: 1200, company: 150, signal: 400 }
// Estimates only, per exact model id, as read on 2026-10-23. A model not listed has no price here and no estimate.
// Keys are `vendor:model`.
export const PRICE_TABLE: Record<string, { input_per_mtok: number; output_per_mtok: number; source: string }> = {
  'anthropic:claude-sonnet-4-5': { input_per_mtok: 3, output_per_mtok: 15, source: 'https://platform.claude.com/docs/en/about-claude/pricing' },
}

export const LITERAL_CAVEAT = 'Literal match only: each quote was found on the named page, but it may be about another company or mean something else, and none of this is a verified fit or buying need.'

export interface Prepared { prompt: string; prompt_sha256: string; scope: EvidenceScope; included: { url: string; text: string; role?: PageRole }[] }

export function preparePrompt(i: QualifyInput, limits: QualifyLimits = DEFAULT_LIMITS): Prepared {
  let budget = Math.max(0, limits.max_input_chars)
  const included: { url: string; text: string; role?: PageRole }[] = []
  const scope: EvidenceScope = { pages_included: [], pages_omitted: [], any_truncated: false }
  for (const p of i.pages) {
    const take = Math.min(budget, Math.max(0, limits.max_page_chars), p.text.length)
    if (take <= 0) { scope.pages_omitted.push(p.url); if (p.text.length > 0) scope.any_truncated = true; continue }
    const text = p.text.slice(0, take); budget -= take
    const truncated = take < p.text.length
    if (truncated) scope.any_truncated = true
    included.push({ url: p.url, text, role: p.role })
    scope.pages_included.push({ url: p.url, role: p.role, chars_sent: take, chars_available: p.text.length, truncated })
  }
  const f = (v: string, n: number) => v.slice(0, n)
  const prompt = `You judge whether ONE company could use a seller's product, using ONLY the page text below.
Seller offer: ${f(i.seller_offer, FIELD_CAPS.seller_offer)}
Seller target profile: ${f(i.seller_icp, FIELD_CAPS.seller_icp)}
Company: ${f(i.company, FIELD_CAPS.company)}
Why it was saved: ${f(i.signal, FIELD_CAPS.signal)} (a hiring signal only; it is not buying intent or fit)

Judge three things separately. "unknown" is a correct answer whenever the text does not show it.
1. company_fit (yes/no/unknown): does the text show the company matches the seller's target profile? Do not assume anything the profile leaves open.
2. use_case (yes/no/unknown): does the text show a way this company's OWN team could use the seller's offer? The company's customers do not count.
3. buying_evidence (stated/none_seen/unknown): does the text explicitly show the company is looking for or evaluating this kind of product? A job posting does not count. none_seen means only that these pages, as shown, do not say so; it is not a claim about the company elsewhere.
Every verdict other than unknown/none_seen needs a quote copied exactly from ONE page, plus that page's URL as quote_url.

Reply with one JSON object and nothing else:
{"company_fit":{"verdict":"","quote":"","quote_url":"","note":""},"use_case":{"verdict":"","quote":"","quote_url":"","note":""},"buying_evidence":{"verdict":"","quote":"","quote_url":"","note":""}}

PAGE TEXT${scope.any_truncated ? ' (some text was cut off or left out to fit the limit)' : ''}
${included.map(p => `--- ${p.url}\n${p.text}`).join('\n')}`
  return { prompt, prompt_sha256: createHash('sha256').update(prompt).digest('hex'), scope, included }
}

export function estimateCost(prompt: string, vendor: string | null, model: string | null, limits: QualifyLimits = DEFAULT_LIMITS) {
  const bytes = Buffer.byteLength(prompt, 'utf8')
  const price = vendor && model ? PRICE_TABLE[`${vendor}:${model}`] ?? null : null
  // Estimate: UTF-8 bytes as a loose ceiling on input tokens (an assumption, not provider-confirmed).
  const usd = price ? (bytes * price.input_per_mtok + limits.max_output_tokens * price.output_per_mtok) / 1e6 : null
  return { vendor, model, chars: prompt.length, bytes, input_tokens_estimate_max: bytes, output_tokens_max: limits.max_output_tokens, limits, field_caps: FIELD_CAPS,
    usd_estimate_max: usd === null ? null : Math.round(usd * 1e6) / 1e6, price_source: price?.source ?? null,
    priced: price !== null, is_guaranteed_cap: false as const }
}

const NONE_SCOPE = (scope: EvidenceScope, why: string): Qualification => {
  const u = <V extends string>(v: V): Judgment<V> => ({ verdict: v, quote: null, quote_url: null, quote_role: null, note: why })
  return { company_fit: u('unknown'), use_case: u('unknown'), buying_evidence: u('unknown'), evidence_scope: scope, caveat: LITERAL_CAVEAT }
}
const REJECT_NOTE: Record<RejectReason, string> = {
  quote_missing: 'dropped: the model gave a verdict with no quote',
  too_short: 'dropped: the quote was too short to check (under 8 characters)',
  url_not_sent: 'dropped: the quote named a page that was not among the pages sent',
  not_on_page: 'dropped: the quote was not found on the page it named among the pages sent',
}
function norm(s: string) { return s.replace(/\s+/g, ' ').trim() }

// Parse, then keep a verdict only if its quote is verbatim inside ONE page that was actually sent, and
// quote_url names that page. Literal presence only: it does not prove the quote means what the verdict says.
export function parseQualification(raw: string, included: { url: string; text: string; role?: PageRole }[], scope: EvidenceScope): Qualification {
  const m = /\{[\s\S]*\}/.exec(raw)
  if (!m) return NONE_SCOPE(scope, 'model output was not readable')
  let j: Record<string, { verdict?: unknown; quote?: unknown; quote_url?: unknown; note?: unknown }>
  try { j = JSON.parse(m[0]) } catch { return NONE_SCOPE(scope, 'model output was not readable') }
  const pages = included.map(p => ({ url: p.url, hay: norm(p.text) }))
  const one = <V extends string>(k: string, ok: readonly V[], none: V): Judgment<V> => {
    const x = j[k] ?? {}
    const v = typeof x.verdict === 'string' && (ok as readonly string[]).includes(x.verdict) ? (x.verdict as V) : none
    const q = typeof x.quote === 'string' ? norm(x.quote) : ''
    const url = typeof x.quote_url === 'string' ? x.quote_url : ''
    const note = typeof x.note === 'string' ? x.note.slice(0, 300) : ''
    const needsQuote = v !== none && (v as string) !== 'none_seen'
    if (!needsQuote) return { verdict: v, quote: null, quote_url: null, quote_role: null, note: v === ('none_seen' as string) ? `${note} (scope: only the ${included.length} page(s) sent${scope.any_truncated ? ', some cut off' : ''})`.trim() : note }
    const page = pages.find(p => p.url === url)
    const reason: RejectReason | null = q.length === 0 ? 'quote_missing' : q.length < 8 ? 'too_short' : !page ? 'url_not_sent' : !page.hay.includes(q) ? 'not_on_page' : null
    if (reason || !page) {
      const sentPage = scope.pages_included.find(x => x.url === url)
      return { verdict: none, quote: null, quote_url: null, quote_role: null, note: REJECT_NOTE[reason ?? 'url_not_sent'], rejected: { reason: reason ?? 'url_not_sent', model_verdict: String(v), quote_chars: q.length, named_page_truncated: sentPage ? sentPage.truncated : null, model_note: note } }
    }
    return { verdict: v, quote: q, quote_url: page.url, quote_role: included.find(x => x.url === page.url)?.role ?? null, note }
  }
  return {
    company_fit: one<FitVerdict>('company_fit', ['yes', 'no', 'unknown'], 'unknown'),
    use_case: one<FitVerdict>('use_case', ['yes', 'no', 'unknown'], 'unknown'),
    buying_evidence: one<BuyVerdict>('buying_evidence', ['stated', 'none_seen', 'unknown'], 'unknown'),
    evidence_scope: scope,
    caveat: LITERAL_CAVEAT,
  }
}

// Approval must name the exact model and the estimate it was shown. Booleans alone are not accepted.
export interface PaidApproval { approved_by_user: true; vendor: string; model: string; max_usd_estimate: number; prompt_sha256: string; limits: QualifyLimits }
export type QualifyResult =
  | { status: 'dry_run'; cost: ReturnType<typeof estimateCost>; scope: EvidenceScope }
  | { status: 'blocked'; reason: 'no_approval' | 'model_mismatch' | 'unpriced_model' | 'over_estimate' | 'content_mismatch' | 'limits_mismatch' | 'no_pages' | 'no_provider'; cost?: ReturnType<typeof estimateCost> }
  | { status: 'done'; qualification: Qualification; cost: ReturnType<typeof estimateCost>; usage?: unknown; served_model: string | null }

// Exactly one provider request. No retry. Without `approval` it only reports the estimate.
export async function qualifyLead(provider: Provider, apiKey: string, input: QualifyInput, opts: { vendor?: string; limits?: QualifyLimits; approval?: PaidApproval; fetchImpl?: typeof fetch } = {}): Promise<QualifyResult> {
  const limits = opts.limits ?? DEFAULT_LIMITS
  if (!input.pages.some(p => p.text.trim().length > 0)) return { status: 'blocked', reason: 'no_pages' }
  const prep = preparePrompt(input, limits)
  const model = provider.configuredModel ? provider.configuredModel() : null
  const cost = estimateCost(prep.prompt, opts.vendor ?? null, model, limits)
  if (!opts.approval) return { status: 'dry_run', cost, scope: prep.scope }
  const a = opts.approval
  if (a.approved_by_user !== true) return { status: 'blocked', reason: 'no_approval', cost }
  if (!cost.priced || cost.usd_estimate_max === null) return { status: 'blocked', reason: 'unpriced_model', cost }
  if (a.model !== model || a.vendor !== opts.vendor) return { status: 'blocked', reason: 'model_mismatch', cost }
  if (JSON.stringify(a.limits) !== JSON.stringify(limits)) return { status: 'blocked', reason: 'limits_mismatch', cost }
  // The exact prompt, evidence text included, is what was shown. If a page changed, the hash differs and the call is refused.
  if (a.prompt_sha256 !== prep.prompt_sha256) return { status: 'blocked', reason: 'content_mismatch', cost }
  if (!Number.isFinite(a.max_usd_estimate) || a.max_usd_estimate < 0 || cost.usd_estimate_max > a.max_usd_estimate) return { status: 'blocked', reason: 'over_estimate', cost }
  if (!provider.completeDetailed) return { status: 'blocked', reason: 'no_provider', cost }
  const r = await provider.completeDetailed(apiKey, prep.prompt, opts.fetchImpl, limits.max_output_tokens)
  return { status: 'done', qualification: parseQualification(r.text, prep.included, prep.scope), cost, usage: r.usage, served_model: r.model }
}
