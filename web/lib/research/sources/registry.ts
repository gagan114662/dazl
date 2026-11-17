// The shape every registry source has, and how a source tells whether a research case is its market (leaf module: no imports of sources).
import type { Candidate, ResearchCase } from '../types.ts'
import type { SafeGet } from '../../sources/types.ts'

export interface RegistrySource {
  id: string
  covers(c: ResearchCase): boolean
  collect(c: ResearchCase, since: string, http: SafeGet): Promise<{ candidates: Candidate[]; notes: string[] }>
}

// The case's place and category in plain words: "Austin, Texas" -> ' austin texas ', "roofing contractors" -> ' roofing contractors '. Coverage is
// decided by the case's CATEGORY alone (the free-text query can name other trades: "solar roofing" must not turn on the roofing permits), and a
// city source's place pattern is anchored to the whole place, city AND region (never "Austin, Minnesota", "Port Austin" or "North Vancouver").
export const words = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `
export const caseMentions = (c: Pick<ResearchCase, 'where' | 'category'>, field: 'where' | 'category', any: RegExp): boolean =>
  any.test(words(field === 'where' ? c.where : c.category))
