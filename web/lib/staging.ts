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
