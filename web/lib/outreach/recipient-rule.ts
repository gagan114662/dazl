// The rules about ONE recipient address that need no database: which mailboxes are personal, which are test fixtures, and the verdict
// on a discovery lead's published address once the facts are read. Pure, so the synchronous store (lib/outreach/service.ts) and the Db
// layer (lib/discover/state-db.ts) apply the same rule to the facts each of them reads, and cannot drift apart (#1238).
import { classifyPurpose } from './published-email.ts'
import { deliverabilityBlocked, type RouteRow } from './contact-route.ts'

const norm = (email: string) => email.trim().toLowerCase()

// Personal mailbox providers: a published address there is not a business contact.
const CONSUMER = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.ca', 'hotmail.com', 'outlook.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com'])

// Off by default. Only the env-designated test tenant (OUTREACH_TEST_TENANT_ID) and this exact
// inbox qualify. This is a code gate only, not evidence of user permission.
export const TEST_INBOX = 'instinct114114@gmail.com'
// Synthetic recipients of the test-only inbox fixture (lib/outreach/inbox-fixture.ts, #369). The .invalid TLD cannot
// resolve, and no draft, send, follow-up or sequence step may ever be addressed to one: recipientAllowed refuses them
// (every follow-up and sequence path checks it), and draft and send refuse them first with their own code.
export const INBOX_FIXTURE_DOMAIN = 'inbox-fixture.dazl.invalid'
export const isInboxFixtureAddress = (email: string): boolean => {
  const d = norm(email).split('@').pop() ?? ''
  return d === INBOX_FIXTURE_DOMAIN || d.endsWith(`.${INBOX_FIXTURE_DOMAIN}`)
}
// The env-designated test tenant may address only the approved test inbox. Every send path
// (draft, manual and autopilot send, follow-up, sequence step, re-open) runs this gate
// synchronously before a send, so the restriction holds at each authoritative send boundary,
// not only in the UI. A missing or malformed allowlist fails closed: nothing is addressable
// for that tenant. Other tenants are unaffected. Code gate only.
export const isDesignatedTestTenant = (tenantId: string): boolean =>
  !!process.env.OUTREACH_TEST_TENANT_ID && process.env.OUTREACH_TEST_TENANT_ID === tenantId
// Is this the approved test inbox of the designated test tenant? `allowlisted`: the tenant's own stored allowlist carries the address
// (read by the caller, and only when everything else already holds).
export const testInboxApproved = (tenantId: string, email: string, allowlisted: () => boolean): boolean =>
  isDesignatedTestTenant(tenantId) && norm(email) === TEST_INBOX && allowlisted()
// May a message be addressed to this mailbox at all: never a fixture address, for the test tenant only its approved inbox, and for
// everyone else no personal mailbox.
export function addressAllowed(tenantId: string, email: string, allowlisted: () => boolean): boolean {
  if (isInboxFixtureAddress(email)) return false
  if (isDesignatedTestTenant(tenantId)) return testInboxApproved(tenantId, email, allowlisted)
  return !CONSUMER.has(norm(email).split('@')[1]) || testInboxApproved(tenantId, email, allowlisted)
}

// Why a draft to a discovery lead's own published address would be refused, apart from the lead's proof (lib/discover/card.ts
// discoverApprove says each in words). 'unreadable' is the caller's: a fact could not be read, which is never "not refused".
export type RecipientRefusal = 'personal_email' | 'suppressed' | 'not_sales' | 'undeliverable' | 'unreadable'
// The verdict from the facts, in one order everywhere: the do-not-contact list, a personal mailbox, a press / support / privacy inbox,
// a mailbox that cannot receive mail. The same four refusals the draft check makes (lib/outreach/service.ts discoverDraftChecks).
// The do-not-contact list comes first because it is about the person and not only the mailbox: it also takes their LinkedIn profile
// out of the count (lib/discover/card.ts discoverLinkedIn), which a personal or dead mailbox does not.
// rows: the lead's stored rows; only its recorded mailbox checks (kind 'deliverability') are read.
export function recipientVerdict(to: string, facts: { allowed: boolean; suppressed: boolean; rows: RouteRow[] }): Exclude<RecipientRefusal, 'unreadable'> | null {
  if (facts.suppressed) return 'suppressed'
  if (!facts.allowed) return 'personal_email'
  if (classifyPurpose(to).purpose === 'non-sales') return 'not_sales'
  if (deliverabilityBlocked(to, facts.rows)) return 'undeliverable'
  return null
}
