// Reviewed worker: deterministic counts over a piece of text. Version 1.1.0 adds a character count; it reads the same
// input and keeps the same stored state (stateVersion 1), so 1.0.0 stays a valid rollback target.
import type { WorkerDefinition } from '../definition.ts'

export const definition: WorkerDefinition = {
  name: 'text-stats',
  version: '1.1.0',
  effect: 'none',
  permissions: [],
  triggers: [{ kind: 'enqueue' }],
  input: { type: 'object', properties: { text: { type: 'string', maxLength: 20_000 } }, required: ['text'] },
  output: {
    type: 'object',
    properties: { words: { type: 'integer', minimum: 0 }, lines: { type: 'integer', minimum: 0 }, chars: { type: 'integer', minimum: 0 } },
    required: ['words', 'lines', 'chars'],
  },
  stateVersion: 1,
  timeoutMs: 2_000,
  maxInputBytes: 65_536,
  maxOutputBytes: 1_024,
  limits: { maxInFlight: 2, perTenantInFlight: 1, maxBacklog: 20, maxAttempts: 3 },
}

export function run(input: unknown): { words: number; lines: number; chars: number } {
  const text = (input as { text: string }).text
  return { words: text.split(/\s+/).filter(Boolean).length, lines: text === '' ? 0 : text.split('\n').length, chars: [...text].length }
}
