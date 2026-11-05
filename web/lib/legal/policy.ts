// Public Terms of Service and Privacy Policy text (#535). The pages in app/terms and app/privacy render only what is
// here, and test/legal-policy.test.ts holds every fact below to the code that implements it (retention constants,
// providers, opt-out handling, outbound footer). Change the code and that test fails until this text is changed too.
//
// This file is deliberately import-free (it is bundled into public pages): the values are copied here and the test
// compares them with the real constants.
//
// Status: DRAFT. Nothing here is a legal conclusion. Statements describe what the software does today. Anything that
// needs the owner or counsel (legal entity, contact, governing law, liability, which laws apply, retention periods not
// yet chosen) is a visible bracketed NEEDS OWNER / NEEDS COUNSEL marker, never an invented term. The draft label stays
// until the owner and qualified counsel approve the final text.

export const POLICY_STATUS = 'draft' as const
export const DRAFT_NOTICE = 'DRAFT - not yet approved by the site owner or reviewed by a lawyer. The statements below describe how the software behaves today; bracketed items are open decisions. Not legal advice.'

// Owner-supplied facts that are not in the code. Each stays a visible placeholder until the owner provides it.
export const OWNER_PLACEHOLDERS = {
  legalName: '[COMPANY LEGAL NAME - NEEDS OWNER]',
  lastUpdated: '[DATE - set when the owner approves this text]',
  privacyContact: '[PRIVACY CONTACT EMAIL - NEEDS OWNER]',
  systemMailProvider: '[SYSTEM EMAIL PROVIDER - NEEDS OWNER]',
} as const

// Facts held to the code by test/legal-policy.test.ts. The comment on each names its source.
export const FACTS = {
  freeScansPerMonth: 50,                 // lib/plans.ts PLAN_LIMITS.free.scansPerMonth
  revokedSessionRetainDays: 30,          // lib/sessions.ts SESSION_RETAIN_S
  systemMailOutboxRetainHours: 24,       // lib/system-mail.ts OUTBOX_RETAIN_S
  accountHistoryFlag: 'ACCOUNT_RETENTION_ENABLED', // lib/account-retention.ts: sessions/outbox reaping is off unless '1'
  evidenceCopyRetainDays: 90,            // lib/scan/evidence-copies.ts RETENTION_DAYS
  consentProofRetainYears: 2,            // lib/outreach/onboarding-policy.ts ONBOARDING_AUDIT_RETAIN_YEARS (DECISIONS.md 2026-11-02)
  auditRetentionFlag: 'AUDIT_RETENTION_DAYS', // lib/audit.ts auditRetention: off (nothing purged) until set
  auditRetentionMinDays: 30,             // lib/audit.ts AUDIT_RETENTION_MIN_DAYS
  traceCaptureFlag: 'DAZL_TRACE_CAPTURE', // lib/evals/capture.ts traceCaptureConfig: off unless '1'
  // lib/tenant/lifecycle.ts ALWAYS_RETAINED: kept after account deletion whatever the deletion policy
  retainedAfterDeletion: ['audit_events', 'evidence_purge_audit', 'onboarding_audit'],
  aiVendors: { anthropic: 'Anthropic', openai: 'OpenAI' }, // lib/llm/vendors.ts VENDORS
  enrichmentProviders: { 'enrich:apollo': 'Apollo', 'enrich:pdl': 'People Data Labs' }, // lib/enrich/index.ts
  crmProviders: { hubspot: 'HubSpot', pipedrive: 'Pipedrive', webhook: 'an HTTPS webhook you control' }, // lib/crm/index.ts
  gmailSendScope: 'https://www.googleapis.com/auth/gmail.send',     // lib/gmail/oauth.ts GMAIL_SEND_SCOPE
  gmailReadScope: 'https://www.googleapis.com/auth/gmail.readonly', // lib/gmail/oauth.ts GMAIL_READ_SCOPE (optional)
  emailGuessFlag: 'EMAIL_GUESS_ENABLED', // lib/people/email-pattern.ts: off unless '1'; candidates stay 'unverified', unread by outreach
  hostingProvider: 'AWS (EC2, region us-east-2)', // reviewer-verified production instance metadata, 2026-11-04 (#613)
} as const

// Every third-party API host the code calls (test/legal-policy.test.ts scans lib/ and app/ for api-style hosts and
// fails on one missing here), with who receives the data and why.
export type HostRole = 'provider' | 'customer_provider' | 'public_source'
export const API_HOSTS: Record<string, { name: string; role: HostRole }> = {
  'accounts.google.com': { name: 'Google', role: 'provider' },
  'oauth2.googleapis.com': { name: 'Google', role: 'provider' },
  'www.googleapis.com': { name: 'Google', role: 'provider' },
  'gmail.googleapis.com': { name: 'Google', role: 'provider' },
  'api.stripe.com': { name: 'Stripe', role: 'provider' },
  'api.anthropic.com': { name: 'Anthropic', role: 'provider' },
  'api.openai.com': { name: 'OpenAI', role: 'customer_provider' },
  'api.search.tinyfish.ai': { name: 'TinyFish', role: 'provider' },
  'api.fetch.tinyfish.ai': { name: 'TinyFish', role: 'provider' },
  'r.jina.ai': { name: 'Jina AI (Reader)', role: 'provider' },
  'api.apollo.io': { name: 'Apollo', role: 'customer_provider' },
  'api.peopledatalabs.com': { name: 'People Data Labs', role: 'customer_provider' },
  'api.hubapi.com': { name: 'HubSpot', role: 'customer_provider' },
  'api.pipedrive.com': { name: 'Pipedrive', role: 'customer_provider' },
  'api.github.com': { name: 'GitHub', role: 'public_source' },
  'boards-api.greenhouse.io': { name: 'Greenhouse job boards', role: 'public_source' },
  'api.lever.co': { name: 'Lever job boards', role: 'public_source' },
  'api.ashbyhq.com': { name: 'Ashby job boards', role: 'public_source' },
  'api.gdeltproject.org': { name: 'GDELT news index', role: 'public_source' },
  'data.brreg.no': { name: 'Brønnøysundregistrene (Norway business register API)', role: 'public_source' },
  'virksomhet.brreg.no': { name: 'Brønnøysundregistrene (Norway business register entity pages)', role: 'public_source' },
  'www.sov2ex.com': { name: 'sov2ex (V2EX topic search)', role: 'public_source' },
  'www.v2ex.com': { name: 'V2EX', role: 'public_source' },
  'hn.algolia.com': { name: 'Hacker News search', role: 'public_source' },
  'efts.sec.gov': { name: 'SEC EDGAR', role: 'public_source' },
}

export interface Section { heading: string; paragraphs: string[] }

const list = (xs: readonly string[]) => xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`
const ai = list(Object.values(FACTS.aiVendors))
const enrich = list(Object.values(FACTS.enrichmentProviders))
const crm = list(Object.values(FACTS.crmProviders))
const P = OWNER_PLACEHOLDERS

export const PRIVACY: Section[] = [
  { heading: 'Who we are', paragraphs: [
    `Last updated: ${P.lastUpdated}. ${P.legalName} ("dazl", "we") operates dazl.ai.`,
  ] },
  { heading: 'What we collect about you (customers)', paragraphs: [
    'Account details: your name, email address, optional business name, and a salted scrypt hash of your password (never the password itself). If you sign in with Google, the email address and account identifier Google returns.',
    'Session records: a hash of each sign-in token, a coarse device label such as "Chrome on macOS" (the raw browser header is not stored), and when the session was last used.',
    `Credentials you give us: AI provider keys, enrichment and CRM keys, and your Gmail authorization. These are stored encrypted (AES-256-GCM, with a key held only in the server environment); the secrets themselves are never included in a data export.`,
    'Your business profile, the prospects your searches find, the drafts and messages you send, and replies dazl reads (see Gmail below).',
  ] },
  { heading: 'What we hold about prospects', paragraphs: [
    'dazl finds businesses and business contacts from public sources: company websites, job boards, SEC filings, official business registers, GitHub, news and community sites. Each lead keeps the link to the page it came from.',
    `Where you connect your own ${enrich} account, contact details those providers return under your key are added to your leads. With the optional advanced connector, LinkedIn results come through your own signed-in session.`,
    `When ${FACTS.emailGuessFlag} is turned on, dazl works out a company's address format from personal addresses it publishes on its own site and prepares candidate addresses for people listed there. Those candidates are stored apart from your leads, marked unverified, and are never shown to you or emailed. [NEEDS OWNER: update this text before mailbox-verified guessed addresses ship (DECISIONS.md 2026-10-26: US recipients only).]`,
    'When dazl could not read a page itself and verified a lead against a copy of its text, that copy is kept with the lead and expires after ' + `${FACTS.evidenceCopyRetainDays} days.`,
    'Prospect data is kept in the workspace of the customer whose search found it; it is not shared with other customers. [NEEDS COUNSEL: whether dazl acts as controller or processor for prospect data, and the lawful basis for each jurisdiction.]',
  ] },
  { heading: 'How we use it', paragraphs: [
    'To run your account, find and score prospects, draft outreach, send the messages you approve (or that autopilot sends under the limits you turned on), keep the service secure, and bill you.',
    `Page text about prospects and your business profile are sent to the AI model provider (${ai}) whose key the request runs on to score leads and write drafts. On the free trial that is dazl's own Anthropic key; otherwise it is the key you saved.`,
  ] },
  { heading: 'Gmail', paragraphs: [
    'Outreach is sent from your own Gmail account. Connecting it grants send access only (gmail.send).',
    'Reading replies is a separate, optional grant (gmail.readonly). With it, dazl opens the threads of the messages it sent and looks for delivery-failure notices about them. [NEEDS OWNER: Google API Services User Data Policy / Limited Use statement wording.]',
  ] },
  { heading: 'Service providers', paragraphs: [
    `Google (sign-in and Gmail), Stripe (payments; card details are entered at Stripe, not on dazl), Anthropic (AI models, including the free trial), TinyFish (web search and page fetching), and Jina AI Reader (reading public pages). Hosting: ${FACTS.hostingProvider}. Account emails such as password resets: ${P.systemMailProvider}. Today no system email provider is configured: sending is off, and those messages are held on the host, then deleted after ${FACTS.systemMailOutboxRetainHours} hours (see Retention). [NEEDS OWNER: choose the provider before account emails are enabled; re-check at launch.]`,
    `Providers you choose and connect with your own account or key: ${ai} (AI models), ${enrich} (contact enrichment), and ${crm} (lead export to your CRM). Their use of the data is governed by your agreement with them.`,
    'Public sources dazl queries with search terms such as a company name receive no account data: GitHub, job boards (Greenhouse, Lever, Ashby), the GDELT news index, Hacker News search, SEC EDGAR, the Norwegian business register (Brønnøysundregistrene), and V2EX topics (read directly and through the sov2ex search service).',
    'Error reports, if an error-monitoring service is configured, carry only the error type, code locations and a request id: never messages, account identifiers, request bodies or personal data.',
    'We do not sell personal information.',
  ] },
  { heading: 'Retention', paragraphs: [
    `Signed-out and expired sessions are kept for ${FACTS.revokedSessionRetainDays} days (to show who signed a device out, and when), then deleted. Undelivered account emails held while email sending is not configured are deleted after ${FACTS.systemMailOutboxRetainHours} hours. [NEEDS OWNER: both deletions run only once ${FACTS.accountHistoryFlag}=1 is set in production; confirm before publishing.]`,
    `Your workspace's audit trail (security, billing, sending and consent actions) is kept until a retention period is chosen; no audit record is deleted automatically today. [NEEDS OWNER: set ${FACTS.auditRetentionFlag}, at least ${FACTS.auditRetentionMinDays} days.]`,
    'Debug copies of scan inputs and outputs are recorded only if trace capture is turned on, and deleted only under a retention period someone chose. [NEEDS OWNER: confirm ' + `${FACTS.traceCaptureFlag} is off in production, or disclose its period.]`,
    'Other account and lead data is kept while your account exists. [NEEDS OWNER: retention for an active account\'s leads and messages, and for backups (not yet implemented).]',
  ] },
  { heading: 'Deleting your account', paragraphs: [
    `You can ask us to export or delete your data at ${P.privacyContact}. There is no self-service deletion button yet; deletion is carried out by us. It removes credentials and sign-in state first, then queued work, then every row your workspace owns.`,
    `Some records survive deletion because they contain no message content: the audit trail, the record of evidence purges, and content-free consent records (only the internal account ID, the action and its time). Consent records are deleted ${FACTS.consentProofRetainYears} years after the deletion completed. [NEEDS COUNSEL: confirm the ${FACTS.consentProofRetainYears}-year period, chosen by the owner as a practical window, not from a statute.]`,
    '[NEEDS OWNER: whether opt-out (unsubscribe) lists are kept or erased on deletion, billing-record retention, and a grace period before erasure (docs/TENANT-LIFECYCLE.md decisions 1, 2 and 5).]',
  ] },
  { heading: 'Your rights', paragraphs: [
    `You can ask to access, correct or delete your data at ${P.privacyContact}. [NEEDS COUNSEL: which rights apply by jurisdiction (GDPR, UK GDPR, CCPA/CPRA, PIPEDA) and response times.]`,
  ] },
  { heading: 'Outbound email and opting out', paragraphs: [
    'Every message sent through dazl ends with the sender\'s name, a mailing address and an unsubscribe link, and carries a one-click List-Unsubscribe header. dazl refuses to send until the sender has saved a name and a mailing address.',
    'An unsubscribe works at once, with no login: the address is added to that sender\'s opt-out list, any drafts or approved messages to it are skipped, and follow-up sequences to it stop. It is never emailed again by that sender through dazl. A bounce is handled the same way.',
    'If you received a message through dazl and want your data removed from the sender\'s workspace, ask the sender, or contact us at ' + `${P.privacyContact}.`,
    '[NEEDS COUNSEL: CASL / CAN-SPAM / PECR / GDPR applicability. These features are not a claim that any particular message complies.]',
  ] },
]

export const TERMS: Section[] = [
  { heading: 'Agreement', paragraphs: [
    `Last updated: ${P.lastUpdated}. These terms are between you and ${P.legalName}. [NEEDS COUNSEL: how acceptance is recorded at sign-up.]`,
  ] },
  { heading: 'The service', paragraphs: [
    'dazl finds prospects from public sources, shows the source for each one, and drafts outreach with AI models. You are the sender of the messages you approve and send, and you are responsible for them.',
    'Autopilot, if you turn it on, sends first-touch emails from your Gmail without asking you each time, within the daily limits you set and only after your first sends were approved by you. You can pause it at any time, and pausing stops sends immediately.',
  ] },
  { heading: 'AI-generated content', paragraphs: [
    'Lead scores, summaries and drafts are produced by AI models and can be wrong. Check the cited source and the draft before you send. Messages do not carry a label saying they were written with AI. [NEEDS COUNSEL: whether any recipient jurisdiction requires such a disclosure.]',
  ] },
  { heading: 'Acceptable use', paragraphs: [
    'No spam, no purchased lists, no messages to people who asked to stop, no illegal or deceptive content. You must comply with the anti-spam and privacy laws that apply to you and your recipients, for example CASL in Canada, CAN-SPAM in the US, and PECR and GDPR in the UK and EU.',
  ] },
  { heading: 'Your keys and connected accounts', paragraphs: [
    `If you connect your own ${ai}, ${enrich} or CRM account, usage on it is billed to you by that provider under your agreement with them. Cost figures dazl shows for those accounts are estimates.`,
  ] },
  { heading: 'Plans and billing', paragraphs: [
    `The free plan includes ${FACTS.freeScansPerMonth} scans a month with your own AI key. Payments are processed by Stripe. [NEEDS OWNER: paid plan prices, renewal, refunds and cancellation terms.]`,
  ] },
  { heading: 'Liability and termination', paragraphs: [
    '[NEEDS COUNSEL: warranty disclaimer, limitation of liability, indemnity, termination, governing law and venue.]',
  ] },
]
