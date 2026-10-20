// PLACEHOLDER limits and prices. Real values are a business decision; set them
// before launch. Costs are in micro-dollars (1e-6 USD) to avoid float drift.
export interface Plan {
  id: 'free' | 'pro'
  monthlyTokenLimit: number // input + output tokens
  monthlyCostLimitMicroUsd: number // hard stop on our own LLM spend per tenant
  maxOutputTokensPerCall: number
}

export const PLANS: Record<Plan['id'], Plan> = {
  free: { id: 'free', monthlyTokenLimit: 100_000, monthlyCostLimitMicroUsd: 1_000_000, maxOutputTokensPerCall: 2_000 },
  pro: { id: 'pro', monthlyTokenLimit: 5_000_000, monthlyCostLimitMicroUsd: 40_000_000, maxOutputTokensPerCall: 4_000 },
}

// micro-USD per 1M tokens, by model. PLACEHOLDER until the vendor is chosen.
export const MODEL_PRICES: Record<string, { inPerM: number; outPerM: number }> = {
  default: { inPerM: 3_000_000, outPerM: 15_000_000 },
}

export function estimateCostMicroUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = MODEL_PRICES[model] ?? MODEL_PRICES.default
  return Math.ceil((inputTokens * p.inPerM + outputTokens * p.outPerM) / 1_000_000)
}
