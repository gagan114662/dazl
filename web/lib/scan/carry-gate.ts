// Server-only half of lib/scan/carry-exclusions.ts (the client imports that file; this one reads tenant memory code).
import { isExcluded, type Memory } from '../memory.ts'
import { listOf } from './carry-exclusions.ts'

// The code-enforced gate (lib/scan/actionable.ts classifyLeads): a lead matching any carried exclusion is never actionable.
export function carriedExcluded(icpJson: string | null | undefined, lead: { company: string; company_domain?: string | null; contact?: string | null }): boolean {
  const xs = listOf(icpJson)
  if (!xs.length) return false
  // "Name (domain.example)" is matched as both the name and the domain; a "label: value" prefix is dropped.
  const terms = xs.flatMap(x => { const v = x.replace(/^[a-z ]{3,20}:\s*/i, ''); const m = /^(.*?)\s*\(([^()]+\.[a-z]{2,})\)\s*$/i.exec(v); return m ? [m[1], m[2]].filter(Boolean) : [v] })
  return isExcluded({ exclusions: terms } as unknown as Memory, lead)
}

