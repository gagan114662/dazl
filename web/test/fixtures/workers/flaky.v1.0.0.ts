// Synthetic worker whose handler always throws: drives the crash-loop and bounded auto-restart tests. Never in the
// app's registry.
import type { WorkerDefinition } from '../../../lib/workers/definition.ts'

export const definition: WorkerDefinition = {
  name: 'flaky',
  version: '1.0.0',
  effect: 'none',
  permissions: [],
  triggers: [{ kind: 'enqueue' }],
  input: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] },
  output: { type: 'object', properties: {} },
  stateVersion: 1,
  timeoutMs: 500,
  maxInputBytes: 256,
  maxOutputBytes: 256,
  limits: { maxInFlight: 4, perTenantInFlight: 4, maxBacklog: 100, maxAttempts: 1 },
}

export function run(): never { throw new Error('always fails') }
