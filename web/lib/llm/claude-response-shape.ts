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
