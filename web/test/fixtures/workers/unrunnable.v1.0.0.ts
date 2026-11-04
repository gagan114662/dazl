// Synthetic workers that must be catalogued but never started (test/workers-catalog.test.ts): a send-effect worker, a
// spend-effect worker, and one that declares a tenant-data permission. Never in the app's registry.
import type { WorkerDefinition } from '../../../lib/workers/definition.ts'

const base = {
  version: '1.0.0',
  triggers: [{ kind: 'enqueue' as const }],
  input: { type: 'object' as const, properties: {} },
  output: { type: 'object' as const, properties: {} },
  stateVersion: 1,
  timeoutMs: 1_000,
  maxInputBytes: 256,
  maxOutputBytes: 256,
  limits: { maxInFlight: 1, perTenantInFlight: 1, maxBacklog: 5, maxAttempts: 1 },
}
export const sender = { definition: { ...base, name: 'sender', effect: 'send', permissions: [] } satisfies WorkerDefinition, run: () => ({}) }
export const spender = { definition: { ...base, name: 'spender', effect: 'spend', permissions: [] } satisfies WorkerDefinition, run: () => ({}) }
export const reader = { definition: { ...base, name: 'reader', effect: 'none', permissions: ['tenant.read.leads'] } satisfies WorkerDefinition, run: () => ({}) }
