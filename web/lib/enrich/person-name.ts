// #383 acceptance: no person is inferred from a generic inbox. A provider result whose "name" is
// mailbox-shaped (info@, sales@, ...) is a mailbox, not a person, at BOTH provider boundaries -
// Apollo and PDL share this one guard so the rule cannot drift between them.
export function isMailboxShaped(name: string): boolean {
  return name.includes('@')
}
