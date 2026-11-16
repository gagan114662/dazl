// Inventory of external and cost-bearing actions (#844, part of #717): every API route that can spend money (a model
// call, a paid search or enrichment lookup, a scan), send something to a third party (outreach mail, system mail,
// Stripe), or read outside pages on a user's behalf, with the lowest access each route requires today.
// test/cost-actions-inventory-844.test.ts fails when a route imports one of COST_BEARING_CALLS without being listed in
// COST_BEARING_ROUTES, or when an entry here no longer matches its route. This is a list, not enforcement: it changes no
// behavior. Gating these on a verified email is #845 (after #1089, verification mail, is live).
import type { Action } from '../workspaces.ts'

export type CostKind =
  | 'model'          // a paid LLM call (BYOK or platform), guarded per docs/spend-safety.md
  | 'scan'           // creates or starts a scan, which makes paid model, TinyFish and enrichment calls
  | 'enrichment'     // a paid or credit-charging contact / company lookup (Apollo, PDL, TinyFish)
  | 'outreach_mail'  // mail sent to a prospect from the user's connected mailbox
  | 'system_mail'    // dazl's own mail (verification, reset, signup notice, play-run mail)
  | 'billing'        // a Stripe call
  | 'page_fetch'     // reads outside web pages (free, but external traffic on the user's behalf)

// Who may trigger it today. An Action is checked with denied(user, action) (lib/workspaces.ts ACTIONS: operate and
// send = operator, billing = owner). 'signed_in' = any member of the workspace, viewers included. 'public' = no account,
// rate-limited only. 'operator_secret' = the scheduler's AUTOPILOT_TICK_SECRET, no user.
export type Requirement = Action | 'signed_in' | 'public' | 'operator_secret'

export interface CostRoute { kinds: CostKind[]; requires: Requirement; note?: string }

// The calls that make a route cost-bearing, by module (path under web/, no extension).
export const COST_BEARING_CALLS: Readonly<Record<string, readonly string[]>> = {
  'lib/scan/runner': ['kickRunner'],
  'lib/scan/store': ['createJob', 'createQueryJob'],
  'lib/workers/runtime': ['enqueueRun'],
  'lib/scan/icp-from-site': ['icpFromWebsite'],
  'lib/scan/qualify-run': ['runQualification'],
  'lib/scan/qualify-preview': ['qualifyPreview'],
  'lib/outreach/draft-llm': ['polishDraft'],
  'lib/replies/threads': ['draftReply'],
  'lib/seo/brief': ['generateBrief'],
  'lib/seo/newsjack': ['createNewsjack'],
  'lib/seo/indexing': ['runIndexChecks'],
  'lib/seo/audit': ['runAudit'],
  'lib/enrich/index': ['retryHeldEnrichment', 'retryCostVerified'],
  'lib/scan/find-contact': ['findContactForConfirmedLead'],
  'lib/people/work-email': ['findWorkEmail', 'workEmailsFor'],
  'lib/scan/commenter-import': ['enrichCommenters'],
  'lib/signals': ['enrichJobSignals'],
  'lib/scan/job-feed': ['createHiringFeedIntake', 'retryHiringFeedContacts'],
  'lib/connectors/sitecrawl': ['crawlJob'],
  'lib/scan/tech-fixture': ['crawlTechFixture'],
  'lib/scan/evidence-recheck': ['evidenceRecheck'],
  'lib/scan/play-research': ['savePlayResearch'],
  'lib/outreach/service': ['sendMessage'],
  'lib/outreach/replies': ['syncReplies'],
  'lib/outreach/followups': ['runFollowups'],
  'lib/outreach/sequences': ['runSequences'],
  'lib/outreach/autopilot': ['runAutopilot', 'drainFirstTouch'],
  'lib/monitors': ['runDueMonitors'],
  'lib/watch': ['runDueWatches'],
  'lib/play-repeat': ['repeatFirstPlays'],
  'lib/play-mail': ['sendPlayRunMails'],
  'lib/email-ownership': ['sendVerification', 'sendSignupNotice', 'requestReset'],
  'lib/billing/stripe': ['createCheckoutUrl'],
}

export const COST_BEARING_ROUTES: Readonly<Record<string, CostRoute>> = {
  '/api/auth/email/send-verification': { kinds: ['system_mail'], requires: 'signed_in' },
  '/api/auth/reset/request': { kinds: ['system_mail'], requires: 'public', note: 'rate-limited per IP and per address' },
  '/api/auth/signin': { kinds: ['system_mail'], requires: 'public', note: 're-sends verification for an unverified account; rate-limited' },
  '/api/auth/signup': { kinds: ['system_mail'], requires: 'public', note: 'rate-limited per IP and per address' },
  '/api/billing/checkout': { kinds: ['billing'], requires: 'billing' },
  '/api/enrich/held': { kinds: ['enrichment'], requires: 'operate' },
  '/api/internal/tick': { kinds: ['scan', 'model', 'outreach_mail', 'system_mail', 'enrichment', 'page_fetch'], requires: 'operator_secret' },
  '/api/leads/[lead]/enrich-retry': { kinds: ['enrichment'], requires: 'operate' },
  '/api/leads/[lead]/find-contact': { kinds: ['enrichment'], requires: 'operate' },
  '/api/leads/[lead]/work-email': { kinds: ['enrichment'], requires: 'operate' },
  '/api/leads/evidence-recheck': { kinds: ['page_fetch'], requires: 'signed_in', note: 'no role check: a viewer can trigger it' },
  '/api/leads/hiring-feed': { kinds: ['page_fetch', 'enrichment'], requires: 'operate' },
  '/api/leads/play-research': { kinds: ['page_fetch'], requires: 'operate' },
  '/api/leads/qualify': { kinds: ['model'], requires: 'operate' },
  '/api/leads/qualify-preview': { kinds: ['page_fetch'], requires: 'signed_in', note: 'no model call; no role check: a viewer can trigger it' },
  '/api/leads/tech-fixture': { kinds: ['page_fetch'], requires: 'operate', note: 'staging only' },
  '/api/outreach/[id]': { kinds: ['outreach_mail'], requires: 'send' },
  '/api/outreach/polish': { kinds: ['model'], requires: 'operate' },
  '/api/outreach/replies': { kinds: ['outreach_mail', 'model'], requires: 'send' },
  '/api/replies/[id]': { kinds: ['model'], requires: 'operate' },
  '/api/scan': { kinds: ['scan'], requires: 'operate' },
  '/api/scan/commenters': { kinds: ['page_fetch', 'enrichment'], requires: 'operate' },
  '/api/scan/csv': { kinds: ['scan'], requires: 'operate' },
  '/api/scan/csv/[batch]': { kinds: ['scan'], requires: 'operate', note: 'POST resumes the batch; GET is read' },
  '/api/scan/icp-from-url': { kinds: ['model', 'page_fetch'], requires: 'operate' },
  '/api/scan/status': { kinds: ['scan'], requires: 'signed_in', note: 'kicks the runner for the caller\'s own pending scan; starts no new scan' },
  '/api/seo/audit': { kinds: ['page_fetch'], requires: 'operate' },
  '/api/seo/brief': { kinds: ['model'], requires: 'operate' },
  '/api/seo/indexing': { kinds: ['enrichment'], requires: 'operate', note: 'TinyFish searches against the weekly allowance' },
  '/api/seo/newsjack': { kinds: ['model'], requires: 'operate' },
  '/api/workers': { kinds: ['scan'], requires: 'operate' },
}

const IMPORT = /import\s*\{([^}]*)\}\s*from\s*['"]@\/([^'"]+?)(?:\.tsx?)?['"]/g

// The cost-bearing calls a route source imports.
export function costCallsIn(source: string): string[] {
  const out: string[] = []
  for (const m of source.matchAll(IMPORT)) {
    const wanted = COST_BEARING_CALLS[m[2]]
    if (!wanted) continue
    const names = m[1].split(',').map(s => s.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0])
    for (const n of wanted) if (names.includes(n)) out.push(n)
  }
  return out
}

// Routes (template -> source) that import a cost-bearing call but have no declared requirement.
export function undeclaredCostRoutes(routes: Record<string, string>, declared: Readonly<Record<string, CostRoute>> = COST_BEARING_ROUTES): string[] {
  return Object.keys(routes).filter(r => costCallsIn(routes[r]).length > 0 && !Object.hasOwn(declared, r)).sort()
}
