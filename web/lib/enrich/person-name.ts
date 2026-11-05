// #383 acceptance: no person is inferred from a generic inbox. A provider result whose "name" is a mailbox - an address
// (info@acme.com), only role-mailbox words ("Info", "Sales Team", "sales.support", "IT Support") or only department-label words
// ("Customer Support", "Hiring Manager", "Finance Department", "Dispatch") - is a mailbox or a team label, not a person, at
// BOTH provider boundaries. Apollo and PDL share this one guard, and the role words are the crawl's own ROLE list, so
// the rule cannot drift between them. A real name that merely contains such a word ("Ana Sales") is not affected.
import { ROLE } from '../connectors/sitecrawl.ts'

// Department words a provider puts in the name field when it has no person: the "name" is the team. Kept out of
// ROLE (the crawl's mailbox list) so this guard can grow without changing what the crawl treats as a role inbox.
const DEPT = /^(customer|success|careers?|hiring|manager|marketing|rep|hr|dev|service|desk|human|resources|recruiting|recruitment|talent|acquisition|billing|accounts|payable|reception|dept|no|reply|development|front|finance|department|operations?|procurement|legal|it|technical|account|management|dispatch)$/i
// Neutral filler that never turns words into a person ("Contact Us"). It only counts alongside at least one real
// role/department word, so filler alone is not a verdict either way.
const FILLER = /^(us|the|at)$/i

export function isMailboxShaped(name: string): boolean {
  if (name.includes('@')) return true
  const words = name.trim().split(/[\s._-]+/).filter(Boolean)
  const strong = (w: string) => ROLE.test(w) || DEPT.test(w)
  return words.length > 0 && words.every(w => strong(w) || FILLER.test(w)) && words.some(strong)
}
