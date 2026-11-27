import type { CompletionUsage } from './provider.ts'

// Prices are USD per million tokens from the vendor's published page, keyed by the exact model id.
export const PRICES_USD_PER_M: Record<string, { in: number; out: number }> = {
  'claude-sonnet-4-5': { in: 3, out: 15 }, // https://docs.anthropic.com/en/docs/about-claude/pricing
  'claude-haiku-4-5': { in: 1, out: 5 },   // same page; the research engine's page reading and company research (MISSION v2, Hermes 15 Nov 02:15)
}
export const INPUT_MARGIN_TOKENS = 1000

// A served model id with a release date (claude-sonnet-4-5-20250929) is priced as its listed alias; anything else must
// match exactly. Unlisted: null.
export function priceOf(model: string | null | undefined): { in: number; out: number } | null {
  if (!model) return null
  return PRICES_USD_PER_M[model] ?? PRICES_USD_PER_M[model.replace(/-\d{8}$/, '')] ?? null
}
// Cache pricing as multiples of the input price (https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching):
// reads 0.1x; writes 1.25x for the 5-minute cache and 2x for the 1-hour cache. The usage dazl keeps does not say which,
// so writes are priced at 2x, the higher of the two (an upper bound, by choice).
export const CACHE_WRITE_FACTOR = 2
export const CACHE_READ_FACTOR = 0.1
export type CompletionCost = { usd: number } | { unknown: 'no_usage' | 'unpriced_model' | 'invalid_usage' }
// What a completion cost from what the vendor reported: the SERVED model's price, input and output tokens, cache writes
// and cache reads (Anthropic's input_tokens excludes both). No usage at all: 'no_usage'; a usage report with no priced
// served model or without valid input/output counts: unknown.
export function completionCost(servedModel: string | null | undefined, usage: CompletionUsage | undefined): CompletionCost {
  if (!usage) return { unknown: 'no_usage' }
  const price = priceOf(servedModel)
  if (!price) return { unknown: 'unpriced_model' }
  const ok = (v: number | undefined, required: boolean) => v === undefined ? !required : Number.isFinite(v) && v >= 0
  if (!ok(usage.input_tokens, true) || !ok(usage.output_tokens, true) || !ok(usage.cache_creation_input_tokens, false) || !ok(usage.cache_read_input_tokens, false)) return { unknown: 'invalid_usage' }
  const usd = (usage.input_tokens! * price.in + usage.output_tokens! * price.out
    + (usage.cache_creation_input_tokens ?? 0) * price.in * CACHE_WRITE_FACTOR + (usage.cache_read_input_tokens ?? 0) * price.in * CACHE_READ_FACTOR) / 1e6
  return { usd }
}
