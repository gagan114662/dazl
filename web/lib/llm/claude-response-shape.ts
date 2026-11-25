import type { ClaudeUsageCounter } from './claude-web-search-estimate.ts'

export const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
export const obj = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
export const arr = (v: unknown): unknown[] => Array.isArray(v) ? v : []
type Absent = 'absent' | 'null'
const absent = (p: Record<string, unknown>, field: string): Absent | undefined =>
  !Object.hasOwn(p, field) ? 'absent' : p[field] === null ? 'null' : undefined
export const projectedObject = (p: Record<string, unknown>, field: string): 'object' | Absent | 'malformed' =>
  absent(p, field) ?? (p[field] !== null && typeof p[field] === 'object' && !Array.isArray(p[field]) ? 'object' : 'malformed')
export const projectedCount = (p: Record<string, unknown>, field: string, bound: number): ClaudeUsageCounter => {
  const state = absent(p, field), v = p[field]
  return state ?? (count(v) ? v <= bound ? v : 'outside_diagnostic_bound' : 'malformed')
}
export function projectedEnum<const T extends string>(p: Record<string, unknown>, field: string, options: readonly T[]): T | Absent | 'malformed' | 'unrecognized' {
  const state = absent(p, field), v = p[field]
  return state ?? (typeof v === 'string' ? options.find(option => option === v) ?? 'unrecognized' : 'malformed')
}

// Messages can omit cache counters on an uncached response. A positive or malformed
// cache creation breakdown still needs its aggregate to account for the request.
export function messageCacheTokens(usage: {
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | null
}): { read: number; written: number } | null {
  const read = usage.cache_read_input_tokens ?? 0
  const written = usage.cache_creation_input_tokens ?? 0
  const split = usage.cache_creation
  if (!count(read) || !count(written)) return null
  if (split != null && (!count(split.ephemeral_5m_input_tokens) || !count(split.ephemeral_1h_input_tokens) ||
      split.ephemeral_5m_input_tokens + split.ephemeral_1h_input_tokens !== written)) return null
  return { read, written }
}
