// Does a named person's title make them the contact for the role the request asked for? Shared by the run report
// (actionable.ts) and the scoreboard so both judge "right person" the same way.
import { titleMatches } from '../people/rank.ts'

const FOUNDER = /\b(?:founder|co-?founder|ceo|chief executive|managing director|owner|president)\b/i

// A named person counts as the contact only when the title is a founder-level role or matches the role the request asked for (a dentist at a SaaS lead is not the decision-maker).
export const personMatchesRole = (value: string, who: string): boolean => { const t = value.split(',').slice(1).join(',').trim(); return FOUNDER.test(t) || titleMatches(t, who).length > 0 }
