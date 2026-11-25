import type { EstimateRow } from '../scan/price-estimate.ts'

export const DISCOVERY_SONNET_MODEL = 'claude-sonnet-5-5'
// USD per million tokens, standard tier; native search fees are USD0.01 each.
export const DISCOVERY_SONNET_PRICE = Object.freeze({ input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, search: 0.01 })

export function discoveryEstimate(lane: 'tiny' | 'small' | 'full', capped: boolean): EstimateRow {
  const usd = lane === 'tiny' ? { min: 0.08, max: 0.3 } : lane === 'small' ? { min: 0.25, max: 0.6 } : { min: 0.3, max: 1 }
  return {
    id: 'claude_discover', label: 'Claude finds leads and checks their proof', provider: 'Anthropic', kind: 'search', unit: 'run',
    unit_usd: 'web searches, page reads and model tokens, billed at what the run uses', units: { min: 1, max: 1 }, usd, capped,
    note: 'Sonnet 5.5 discovery and Haiku contact checks share at most 15 web searches for the whole scan. A second loop and contact checks run only when budget remains. Token charges are a soft estimate, not a provider billing ceiling.',
  }
}
