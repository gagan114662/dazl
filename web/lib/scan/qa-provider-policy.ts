// Explicit versioned request mode and its server-written policy. This can only narrow the caller's own scan.
export const QA_CLAUDE_ONLY = 'claude_only_v1'
export const QA_SPEND_MAX_USD = 5

// Older servers reject this mode as unknown instead of running the ordinary first play.
export const FIRST5_CLAUDE_ONLY_MODE = 'first5_claude_only_v1'
export const PINNED_FIRST5_CLAUDE_ONLY_MODE = 'first5_claude_only_pinned_v2'
export const NATIVE_SEARCH_FIRST5_CLAUDE_ONLY_MODE = 'first5_claude_only_search_v3'
export const QA_NATIVE_WEB_SEARCH_POLICY = 'anthropic_estimated_v1'
export const QA_NATIVE_WEB_SEARCH_MAX_USES = 2
export const QA_NATIVE_WEB_SEARCH_RESULT_TOKENS = 25_000
export const QA_NATIVE_WEB_SEARCH_FEE_USD = 0.01
export const QA_NATIVE_WEB_SEARCH_OWN_KEY_MESSAGE = 'Claude Web Search requires your workspace’s own active Anthropic key. Nothing was started.'
export const isClaudeOnlyNativeSearchRequestMode = (mode: unknown): boolean => mode === NATIVE_SEARCH_FIRST5_CLAUDE_ONLY_MODE
export const QA_LOCAL_EXECUTION = 'local_once_v1'
export const isClaudeOnlyRequestMode = (mode: unknown): boolean => mode === FIRST5_CLAUDE_ONLY_MODE || mode === PINNED_FIRST5_CLAUDE_ONLY_MODE || isClaudeOnlyNativeSearchRequestMode(mode)
export const isFirst5RequestMode = (mode: unknown): boolean => mode === 'first5' || isClaudeOnlyRequestMode(mode)

export function qaPinnedLocalJob(raw: string | null | undefined): boolean {
  if (!qaClaudeOnlyJob(raw)) return false
  return JSON.parse(raw!).execution === QA_LOCAL_EXECUTION
}

export function strictLocalTopologySupported(kind: 'sqlite' | 'pg', env: Record<string, string | undefined> = process.env): boolean {
  // The pinned local lane does not participate in cross-process queue slot accounting.
  return kind === 'sqlite' && env.DAZL_SCAN_SHARED_QUEUE !== '1' && !env.DAZL_QUEUE_TENANTS?.trim()
}

export function qaClaudeOnlyJob(raw: string | null | undefined): boolean {
  if (!raw) return false
  try { return JSON.parse(raw)?.provider_policy === QA_CLAUDE_ONLY } catch { return false }
}

// Only the exact server-admitted request mode can mint this marker; ignore markers from raw budgets.
export function qaClaudeOnlyBudget(raw: string | null, mode?: unknown): string {
  const budget = raw ? JSON.parse(raw) : {}
  delete budget.web_search_policy
  return JSON.stringify({ ...budget, provider_policy: QA_CLAUDE_ONLY, paid_fallback: false, credit_enrichment: false,
    ...(isClaudeOnlyNativeSearchRequestMode(mode) ? { web_search_policy: QA_NATIVE_WEB_SEARCH_POLICY } : {}),
    max_usd: Math.min(budget.max_usd ?? QA_SPEND_MAX_USD, QA_SPEND_MAX_USD) })
}

// A local zero-price override is not proof of free-only vendor billing. Public sources do not use this transport.
export function qaClaudeOnlyTransport(kind: string): boolean {
  return kind === 'llm.anthropic' || kind === 'llm.anthropic.web_search'
}

export function qaClaudeOnlyNativeSearchJob(raw: string | null | undefined): boolean {
  if (!qaPinnedLocalJob(raw)) return false
  const b = JSON.parse(raw!)
  return b.first5 === true && b.paid_fallback === false && b.credit_enrichment === false &&
    b.web_search_policy === QA_NATIVE_WEB_SEARCH_POLICY
}
