/** Purely classifies mailbox names that indicate automated or undeliverable mail. */
export function undeliverableAddress(email: string): { blocked: boolean; reason: string } {
  const local = typeof email === 'string' ? email.trim().split('@', 1)[0].split('+', 1)[0].toLowerCase() : ''
  const blocked = /^(?:no-reply|noreply|do-not-reply|donotreply|mailer-daemon|mailerdaemon|postmaster|bounce|bounces|unsubscribe|notifications|notification)$/.test(local)
  return blocked
    ? { blocked: true, reason: 'This mailbox is reserved for automated or undeliverable messages.' }
    : { blocked: false, reason: '' }
}
