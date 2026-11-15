// The shape every registry source has, and how a source tells whether a research case is its market (leaf module: no imports of sources).
import type { Candidate, ResearchCase } from '../types.ts'
import type { SafeGet } from '../../sources/types.ts'

export interface RegistrySource {
  id: string
  covers(c: ResearchCase): boolean
  collect(c: ResearchCase, since: string, http: SafeGet): Promise<{ candidates: Candidate[]; notes: string[] }>
}

// The case's place and category in plain words: "Austin, Texas" / "roofing contractors" -> ' austin texas ', tested against a source's words.
const words = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `
export const caseMentions = (c: Pick<ResearchCase, 'where' | 'category' | 'query'>, field: 'where' | 'category', any: RegExp): boolean =>
  any.test(words(field === 'where' ? c.where : `${c.category} ${c.query}`))
