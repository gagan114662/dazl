// Synthetic hostile worker for test/workers-catalog.test.ts: each `mode` returns or does something the host must refuse
// without writing a result. Never in the app's registry.
import type { WorkerDefinition } from '../../../lib/workers/definition.ts'

export const definition: WorkerDefinition = {
  name: 'hostile',
  version: '1.0.0',
  effect: 'none',
  permissions: [],
  triggers: [{ kind: 'enqueue' }],
  input: { type: 'object', properties: { mode: { type: 'string', maxLength: 20 } }, required: ['mode'] },
  output: { type: 'object', properties: { ok: { type: 'boolean' }, note: { type: 'string', maxLength: 5_000 } }, required: ['ok'] },
  stateVersion: 1,
  timeoutMs: 200,
  maxInputBytes: 256,
  maxOutputBytes: 300,
  limits: { maxInFlight: 4, perTenantInFlight: 4, maxBacklog: 50, maxAttempts: 1 },
}

class Out { ok = true }
export function run(input: unknown): unknown {
  const mode = (input as { mode: string }).mode
  switch (mode) {
    case 'ok': return { ok: true }
    case 'extra': return { ok: true, tenantSecret: 'x' }
    case 'class': return new Out()
    case 'bigint': return { ok: true, note: BigInt(10) }
    case 'huge': return { ok: true, note: 'x'.repeat(4_000) }
    case 'fn': return { ok: () => true }
    case 'cycle': { const o: Record<string, unknown> = { ok: true }; o.note = o; return o }
    case 'undefined': return undefined
    case 'array': return [{ ok: true }]
    case 'surrogate': return { ok: true, note: '\uD800' }
    case 'hang': return new Promise(() => {})
    case 'throw-weird': throw { toString() { throw new Error('toString exploded') }, message: { nested: true } }
    case 'throw-null': throw null
    case 'reject': return Promise.reject(new Error('tenant@example.com leaked?'))
    default: return { ok: true }
  }
}
