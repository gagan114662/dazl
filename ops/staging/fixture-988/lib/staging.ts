// Staging (staging.dazl.ai, docs/STAGING.md): the app runs with DAZL_ENV=staging on its own database, with test data
// only. In staging:
//   - every page shows a "Staging - test data" banner and is noindex (app/layout.tsx, app/robots.ts, next.config.ts)
//   - Gmail is stubbed (lib/gmail/oauth.ts): connecting needs no Google account, sending makes no network call and
//     returns a stub message id, and reply sync reads nothing. No email can leave a staging server.
//   - error reports are tagged environment=staging (lib/ops/errors.ts)
// DAZL_ENV is read at build time for the pages (the banner is in the prerendered shell), so a staging build must run
// with it set; the deploy script (ops/staging/deploy.sh) sources the staging env file before building.
export type Env = Record<string, string | undefined>
export const isStaging = (env: Env = process.env): boolean => env.DAZL_ENV === 'staging'
export const STAGING_BANNER = 'Staging - test data'
// The stub's sender address: on a reserved test domain, so even a mistaken real send could not reach anyone.
export const STUB_SENDER = (tenantId: string) => `sender-${tenantId.slice(0, 8)}@staging.dazl.test`

// Real staging Gmail (issue #413): OFF unless DAZL_ENV=staging AND DAZL_STAGING_REAL_GMAIL=1. The flag is inert everywhere else
// (production never reads it). With the flag off, Gmail stays the stub above, unchanged. With it on, the transport is real only
// when its whole configuration is present - a staging-only OAuth client under its own names (never GOOGLE_CLIENT_ID/SECRET, which
// would disable staging sign-in) and an exact-address allowlist of owner-controlled inboxes. Anything missing is 'misconfigured':
// every Gmail call refuses, nothing falls back to a real send and no provider request is made.
export type StagingGmail =
  | { mode: 'off' } // not staging: production path, flag ignored
  | { mode: 'stub' } // staging, flag off: today's stub
  | { mode: 'real'; clientId: string; clientSecret: string; allowlist: ReadonlySet<string> }
  | { mode: 'misconfigured'; missing: string[] }
const ALLOWLIST_ADDR = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/
export function parseGmailAllowlist(raw: string | undefined): { allowlist: Set<string>; invalid: boolean } {
  const parts = (raw ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)
  const allowlist = new Set(parts.filter((x) => ALLOWLIST_ADDR.test(x) && !x.includes('*')))
  return { allowlist, invalid: parts.length !== allowlist.size }
}
export function stagingGmail(env: Env = process.env): StagingGmail {
  if (!isStaging(env)) return { mode: 'off' }
  if (env.DAZL_STAGING_REAL_GMAIL !== '1') return { mode: 'stub' }
  const clientId = env.GMAIL_STAGING_CLIENT_ID?.trim() ?? ''
  const clientSecret = env.GMAIL_STAGING_CLIENT_SECRET?.trim() ?? ''
  const { allowlist, invalid } = parseGmailAllowlist(env.DAZL_STAGING_GMAIL_ALLOWLIST)
  const missing = [
    ...(clientId ? [] : ['GMAIL_STAGING_CLIENT_ID']),
    ...(clientSecret ? [] : ['GMAIL_STAGING_CLIENT_SECRET']),
    ...(allowlist.size === 0 || invalid ? ['DAZL_STAGING_GMAIL_ALLOWLIST'] : []),
  ]
  return missing.length ? { mode: 'misconfigured', missing } : { mode: 'real', clientId, clientSecret, allowlist }
}
// True when no real mailbox is behind Gmail calls (the stub): reply sync has nothing to read.
export const gmailIsStubbed = (env: Env = process.env): boolean => stagingGmail(env).mode === 'stub'
