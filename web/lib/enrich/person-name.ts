// #383 acceptance: no person is inferred from a generic inbox. A provider result whose "name" is a mailbox - an address
// (info@acme.com) or only role words ("Info", "Sales Team", "Contact Us", "Customer Support", "Hiring Manager") - is a
// mailbox/department, not a person, at BOTH provider boundaries. Apollo and PDL share this one guard. The base words are
// the crawl's own ROLE list; DEPARTMENT_WORDS adds the generic-department labels providers return as "names" (found by
// Instinct's probe of 1123156d). A real name that merely contains such a word ("Ana Sales", "Dev Patel") is unaffected:
// EVERY word must be a role/department/filler word, and at least one must be a role/department word.
import { ROLE } from '../connectors/sitecrawl.ts'

// Why a separate list: widening the crawl's ROLE would change which site addresses the crawl treats as generic inboxes.
const DEPARTMENT_WORDS = /^(customer|customers|client|clients|success|careers|career|jobs|recruiting|recruitment|recruiter|hiring|manager|marketing|rep|reps|hr|dev|devs|billing|accounts|account|service|services|staff|department|dept|desk|studio|group)$/i
// Filler that carries no identity ("Contact Us", "Talk to the Team"); never enough on its own to make a mailbox.
const FILLER_WORDS = /^(us|the|at|our|to|with|of|for|and|a)$/i

export function isMailboxShaped(name: string): boolean {
  if (name.includes('@')) return true
  const words = name.trim().split(/[\s._-]+/).filter(Boolean)
  const isRole = (w: string) => ROLE.test(w) || DEPARTMENT_WORDS.test(w)
  return words.length > 0 && words.some(isRole) && words.every(w => isRole(w) || FILLER_WORDS.test(w))
}
