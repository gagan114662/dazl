// #383 acceptance: no person is inferred from a generic inbox. A provider result whose "name" is a mailbox - an address
// (info@acme.com) or only role-mailbox words ("Info", "Sales Team", "sales.support") - is a mailbox, not a person, at
// BOTH provider boundaries. Apollo and PDL share this one guard, and the role words are the crawl's own ROLE list, so
// the rule cannot drift between them. A real name that merely contains such a word ("Ana Sales") is not affected.
import { ROLE } from '../connectors/sitecrawl.ts'

export function isMailboxShaped(name: string): boolean {
  if (name.includes('@')) return true
  const words = name.trim().split(/[\s._-]+/).filter(Boolean)
  return words.length > 0 && words.every(w => ROLE.test(w))
}
