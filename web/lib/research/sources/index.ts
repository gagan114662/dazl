// MISSION v2 part E: the registry sources hunt.ts hands in as `extra` (lib/research/hunt.ts registryCandidates). Each one returns A's
// Candidate (lib/research/types.ts) with via 'registry' and dated 'registry': the date is the record's own structured field (a permit's issue
// day, a licence's issue day), never a date read out of page text. A source never sees a tenant, a key or the database.
//
// A Candidate's url is the READABLE public record (the open-data API's JSON for that one record), so the read stage can open it: the
// human-facing page of a permit sits behind a captcha (Austin), and the snippet carries the record's facts in words for the same reason.
import type { Candidate, ResearchCase } from '../types.ts'
import type { RegistrySource } from './registry.ts'
import type { SafeGet } from '../../sources/types.ts'
import { austinPermitsSource } from './socrata-permits.ts'
import { vancouverLicencesSource } from './opendatasoft-licences.ts'
import { secFormD } from './sec-form-d.ts'
export type { RegistrySource } from './registry.ts'

export const REGISTRY_SOURCES: RegistrySource[] = [austinPermitsSource, vancouverLicencesSource, secFormD]

export async function collectRegistry(c: ResearchCase, since: string, http: SafeGet, sources: RegistrySource[] = REGISTRY_SOURCES): Promise<{ candidates: Candidate[]; notes: Record<string, string[]> }> {
  const candidates: Candidate[] = [], notes: Record<string, string[]> = {}
  for (const s of sources.filter(x => x.covers(c))) {
    const r = await s.collect(c, since, http).catch(() => ({ candidates: [], notes: ['error'] }))
    candidates.push(...r.candidates)
    if (r.notes.length) notes[s.id] = r.notes
  }
  return { candidates, notes }
}
