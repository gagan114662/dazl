// Reviewed worker: deterministic counts over a piece of text. No effect, no permissions, no tenant data beyond its
// input. Version 1.0.0.
import type { WorkerDefinition } from '../definition.ts'

export const definition: WorkerDefinition = {
  name: 'text-stats',
  version: '1.0.0',
  effect: 'none',
  permissions: [],
  triggers: [{ kind: 'enqueue' }],
  input: { type: 'object', properties: { text: { type: 'string', maxLength: 20_000 } }, required: ['text'] },
  output: { type: 'object', properties: { words: { type: 'integer', minimum: 0 }, lines: { type: 'integer', minimum: 0 } }, required: ['words', 'lines'] },
  stateVersion: 1,
  timeoutMs: 2_000,
  maxInputBytes: 65_536,
  maxOutputBytes: 1_024,
  limits: { maxInFlight: 2, perTenantInFlight: 1, maxBacklog: 20, maxAttempts: 3 },
}

export function run(input: unknown): { words: number; lines: number } {
  const text = (input as { text: string }).text
  return { words: text.split(/\s+/).filter(Boolean).length, lines: text === '' ? 0 : text.split('\n').length }
}
