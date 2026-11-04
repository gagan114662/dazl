// What a reviewed worker declares (docs/design/runtime-workers.md): name, version, input/output schemas, triggers, effect
// class and permissions, plus the limits its deployment starts with. checkDefinition() is the single gate every
// definition passes before it can be registered; registration itself grants nothing (lib/workers/store.ts).
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { checkSchema, type Schema } from './schema.ts'

export const EFFECTS = ['none', 'draft', 'send', 'spend'] as const
export type Effect = typeof EFFECTS[number]
// Effects this runtime will execute. A 'draft' worker's output is a proposal stored on its run; nothing is sent. Send
// and spend workers can be catalogued but never started here: they need their own send/spend authority (#363), and
// such work is never retried automatically.
export const RUNNABLE_EFFECTS: readonly Effect[] = ['none', 'draft']

// The closed permission vocabulary a definition may declare. Declaring one grants nothing.
export const PERMISSIONS = ['tenant.read.leads', 'tenant.write.drafts', 'net.fetch', 'model.call'] as const
// Capabilities this runtime can actually hand a worker today: none. A worker declaring any permission is catalogued but
// refused at start, so registering a worker can never open tenant data, the network or a paid provider.
export const PROVIDED_PERMISSIONS: readonly string[] = []

export const TRIGGERS = ['enqueue'] as const
export type Trigger = { kind: typeof TRIGGERS[number] }

export type Limits = { maxInFlight: number; perTenantInFlight: number; maxBacklog: number; maxAttempts: number }
// Bounds on what an operator may set (lib/workers/store.ts setLimits) or a definition may start with.
export const LIMIT_BOUNDS: Record<keyof Limits, [number, number]> = { maxInFlight: [1, 32], perTenantInFlight: [1, 8], maxBacklog: [1, 1000], maxAttempts: [1, 5] }

export interface WorkerDefinition {
  name: string
  version: string
  effect: Effect
  permissions: string[]
  triggers: Trigger[]
  input: Schema
  output: Schema
  // Shape of the state a version reads and writes (its stored runs and queued inputs). Rollback is allowed only between
  // versions with the same stateVersion, so a rolled-back worker never meets state it cannot read.
  stateVersion: number
  timeoutMs: number
  maxInputBytes: number
  maxOutputBytes: number
  limits: Limits
}

// What a reviewed module exports: its definition and a pure handler. The handler gets plain-data input and the tenant
// id from the authenticated enqueue, nothing else: no database handle, no keys, no network capability.
export interface WorkerModule {
  definition: WorkerDefinition
  run(input: unknown, ctx: { tenantId: string; signal: AbortSignal }): unknown
}

export const NAME_RE = /^[a-z][a-z0-9-]{1,39}$/
export const VERSION_RE = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/
export const HASH_RE = /^[a-f0-9]{64}$/

const isPlain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v))
const intIn = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi

// The first problem with a definition, or null. Accepts unknown so a malformed module or a stored row can be checked.
export function checkDefinition(d: unknown): string | null {
  if (!isPlain(d)) return 'definition must be an object'
  const keys = ['name', 'version', 'effect', 'permissions', 'triggers', 'input', 'output', 'stateVersion', 'timeoutMs', 'maxInputBytes', 'maxOutputBytes', 'limits']
  for (const k of Object.keys(d)) if (!keys.includes(k)) return `unknown key ${k.slice(0, 40)}`
  if (typeof d.name !== 'string' || !NAME_RE.test(d.name)) return 'bad name'
  if (typeof d.version !== 'string' || !VERSION_RE.test(d.version)) return 'bad version'
  if (typeof d.effect !== 'string' || !(EFFECTS as readonly string[]).includes(d.effect)) return 'bad effect'
  if (!Array.isArray(d.permissions) || d.permissions.length > PERMISSIONS.length || !d.permissions.every(p => typeof p === 'string' && (PERMISSIONS as readonly string[]).includes(p))
    || new Set(d.permissions).size !== d.permissions.length) return 'bad permissions'
  if (!Array.isArray(d.triggers) || d.triggers.length < 1 || d.triggers.length > TRIGGERS.length
    || !d.triggers.every(t => isPlain(t) && Object.keys(t).length === 1 && (TRIGGERS as readonly unknown[]).includes(t.kind))) return 'bad triggers'
  for (const k of ['input', 'output'] as const) { const e = checkSchema(d[k]); if (e) return `${k} schema: ${e}` }
  if (!intIn(d.stateVersion, 1, 1_000_000)) return 'bad stateVersion'
  if (!intIn(d.timeoutMs, 100, 120_000)) return 'bad timeoutMs'
  if (!intIn(d.maxInputBytes, 2, 65_536)) return 'bad maxInputBytes'
  if (!intIn(d.maxOutputBytes, 2, 65_536)) return 'bad maxOutputBytes'
  if (!isPlain(d.limits)) return 'bad limits'
  const lk = Object.keys(LIMIT_BOUNDS) as (keyof Limits)[]
  if (Object.keys(d.limits).length !== lk.length) return 'bad limits'
  for (const k of lk) if (!intIn(d.limits[k], ...LIMIT_BOUNDS[k])) return `bad limits.${k}`
  return null
}

// Why a definition may be catalogued but not run here, or null when this runtime can run it.
export function unrunnable(d: WorkerDefinition): string | null {
  if (!RUNNABLE_EFFECTS.includes(d.effect)) return 'effect_requires_authority'
  if (d.permissions.some(p => !PROVIDED_PERMISSIONS.includes(p))) return 'permission_unavailable'
  return null
}

// A reviewed module as the catalog sees it: its exports, its source file, and the sha256 pinned at review time
// (lib/workers/registry.ts lists the ones this build ships).
export interface RegistryEntry { module: WorkerModule; file: URL; sha256: string }
export type Registry = ReadonlyMap<string, RegistryEntry>
export const key = (name: string, version: string) => `${name}@${version}`

// sha256 of the module's source as it is on disk now; null when it cannot be read (fail closed: no hash, no run).
export function fileHash(e: RegistryEntry): string | null {
  try { return createHash('sha256').update(readFileSync(e.file)).digest('hex') } catch { return null }
}
