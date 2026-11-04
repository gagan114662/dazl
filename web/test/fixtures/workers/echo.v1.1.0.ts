// Synthetic worker modules for the runtime-worker tests (test/workers-*.test.ts). Never in the app's registry.
// One file per module so each has its own code hash, like a reviewed module (lib/workers/reviewed/).
import type { WorkerDefinition } from '../../../lib/workers/definition.ts'

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>(r => { const t = setTimeout(r, ms); signal.addEventListener('abort', () => { clearTimeout(t); r() }, { once: true }) })

export const definition: WorkerDefinition = {
  name: 'echo',
  version: '1.1.0',
  effect: 'none',
  permissions: [],
  triggers: [{ kind: 'enqueue' }],
  input: { type: 'object', properties: { n: { type: 'integer', minimum: 0, maximum: 1_000_000 }, sleepMs: { type: 'integer', minimum: 0, maximum: 10_000 } }, required: ['n'] },
  output: { type: 'object', properties: { n: { type: 'integer' }, by: { type: 'string', maxLength: 20 } }, required: ['n', 'by'] },
  stateVersion: 1,
  timeoutMs: 1_000,
  maxInputBytes: 1_024,
  maxOutputBytes: 256,
  limits: { maxInFlight: 2, perTenantInFlight: 1, maxBacklog: 50, maxAttempts: 3 },
}

export async function run(input: unknown, ctx: { signal: AbortSignal }): Promise<{ n: number; by: string }> {
  const i = input as { n: number; sleepMs?: number }
  if (i.sleepMs) await sleep(i.sleepMs, ctx.signal)
  return { n: i.n, by: definition.version }
}
