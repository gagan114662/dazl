// Explicit versioned request mode and its server-written policy. This can only narrow the caller's own scan.
export const QA_CLAUDE_ONLY = 'claude_only_v1'
export const QA_SPEND_MAX_USD = 5

// Older servers reject this mode as unknown instead of running the ordinary first play.
export const FIRST5_CLAUDE_ONLY_MODE = 'first5_claude_only_v1'
export const isFirst5RequestMode = (mode: unknown): boolean => mode === 'first5' || mode === FIRST5_CLAUDE_ONLY_MODE

export function qaClaudeOnlyJob(raw: string | null | undefined): boolean {
  if (!raw) return false
  try { return JSON.parse(raw)?.provider_policy === QA_CLAUDE_ONLY } catch { return false }
}

export function qaClaudeOnlyBudget(raw: string | null): string {
  const budget = raw ? JSON.parse(raw) : {}
  return JSON.stringify({ ...budget, provider_policy: QA_CLAUDE_ONLY, paid_fallback: false, credit_enrichment: false,
    max_usd: Math.min(budget.max_usd ?? QA_SPEND_MAX_USD, QA_SPEND_MAX_USD) })
}

// A local zero-price override is not proof of free-only vendor billing. Public sources do not use this transport.
export function qaClaudeOnlyTransport(kind: string): boolean {
  return kind === 'llm.anthropic'
}
