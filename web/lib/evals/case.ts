// Cases (docs/design/agent-evals.md): one replayable task = a World + the input the agent was given + what a correct run
// must and must not produce. Expectations name outcomes only (verified / held / absent per company), never how the agent
// gets there, so the same case scores two agent versions. Ground truth the World cannot hold (which domains really
// belong to a company) lives here, in `expect.entities`, never in the World the agent sees.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { validateWorld, type World } from './world.ts'

export const CASE_VERSION = 1
export type LeadOutcome = 'verified' | 'held' | 'absent'
export interface Case {
  v: typeof CASE_VERSION; kind: 'dazl.case'; id: string; title: string
  path: 'scan.discovery'
  world: string                                   // path to the World file, relative to the case file
  provenance: { from_trace: string; synthetic: boolean; why: string }
  input: { request: string; icp: unknown; score?: boolean; ground?: boolean }
  expect: {
    leads: { company: string; outcome: LeadOutcome; review_reason?: string; why?: string }[]
    exhaustive?: boolean                          // true: a verified lead for a company not listed is a failure
    entities?: Record<string, { domains: string[] }>
    window_days?: number                          // default: the profile's window_days, else 90
  }
}

export class CaseError extends Error {}

export function validateCase(c: unknown): Case {
  const o = c as Partial<Case> | null
  if (!o || typeof o !== 'object') throw new CaseError('case: not an object')
  if (o.kind !== 'dazl.case' || o.v !== CASE_VERSION) throw new CaseError('case: kind must be dazl.case, v 1')
  if (!o.id || !o.title || typeof o.world !== 'string') throw new CaseError('case: id, title and world required')
  if (o.path !== 'scan.discovery') throw new CaseError(`case: unsupported path ${String(o.path)}`)
  if (!o.input || typeof o.input.request !== 'string' || !o.input.icp) throw new CaseError('case: input.request and input.icp required')
  if (!o.provenance || typeof o.provenance.from_trace !== 'string' || typeof o.provenance.synthetic !== 'boolean') throw new CaseError('case: provenance.from_trace and provenance.synthetic required')
  if (!o.expect || !Array.isArray(o.expect.leads) || o.expect.leads.length === 0) throw new CaseError('case: expect.leads must name at least one outcome')
  for (const l of o.expect.leads) if (!l.company || !['verified', 'held', 'absent'].includes(l.outcome)) throw new CaseError(`case: bad expectation ${JSON.stringify(l)}`)
  return o as Case
}

export function loadCase(file: string): { kase: Case; world: World } {
  const kase = validateCase(JSON.parse(readFileSync(file, 'utf8')))
  const world = validateWorld(JSON.parse(readFileSync(resolve(dirname(file), kase.world), 'utf8')))
  if (kase.provenance.synthetic && world.origin !== 'synthetic') throw new CaseError(`case ${kase.id}: marked synthetic but its world is ${world.origin}`)
  if (!kase.provenance.synthetic && world.origin === 'synthetic') throw new CaseError(`case ${kase.id}: a synthetic world cannot back a recorded case`)
  return { kase, world }
}
