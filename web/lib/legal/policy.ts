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
// legalName, companyRegistration and privacyContact: owner-confirmed 2026-11-06 (#535) and checked against the
// Ajman Free Zone licence and Commercial Registry. Only document-verified fields are used here.
// NEEDS COUNSEL: the licence activity is 'Management Consultancies'; counsel to confirm it covers operating dazl.
export const OWNER_PLACEHOLDERS = {
  legalName: 'Mathematricks - F.Z.E',
  companyRegistration: 'a Free Zone Establishment with limited liability in the Ajman Free Zone, United Arab Emirates (licence and registration no. 47839, first issued 23 July 2025; authorized capital AED 100,000), with its premises at Office C1-1F-SF11592, Ajman Free Zone C1 Building, Ajman, United Arab Emirates',
  lastUpdated: '[DATE - set when the owner approves this text]',
  privacyContact: 'privacy@dazl.ai',
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
  'api.zerobounce.net': { name: 'ZeroBounce', role: 'provider' }, // #899: mailbox check of a guessed US work address; only with EMAIL_GUESS_ENABLED and an operator key
  'api.hubapi.com': { name: 'HubSpot', role: 'customer_provider' },
  'api.pipedrive.com': { name: 'Pipedrive', role: 'customer_provider' },
  'api.github.com': { name: 'GitHub', role: 'public_source' },
  'boards-api.greenhouse.io': { name: 'Greenhouse job boards', role: 'public_source' },
  'api.lever.co': { name: 'Lever job boards', role: 'public_source' },
  'api.ashbyhq.com': { name: 'Ashby job boards', role: 'public_source' },
  'api.gdeltproject.org': { name: 'GDELT news index', role: 'public_source' },
  'data.brreg.no': { name: 'Brønnøysundregistrene (Norway business register API)', role: 'public_source' },
  'api.company-information.service.gov.uk': { name: 'Companies House (UK company register API)', role: 'public_source' },
  'find-and-update.company-information.service.gov.uk': { name: 'Companies House (UK company register pages)', role: 'public_source' },
  'www.sov2ex.com': { name: 'sov2ex (V2EX topic search)', role: 'public_source' },
  'www.v2ex.com': { name: 'V2EX', role: 'public_source' },
  'hn.algolia.com': { name: 'Hacker News search', role: 'public_source' },
  'efts.sec.gov': { name: 'SEC EDGAR', role: 'public_source' },
  'weworkremotely.com': { name: 'We Work Remotely (public job feed)', role: 'public_source' },
}

// Hosts the code names but NEVER calls, each with the reason. test/legal-policy.test.ts fails on any https://host
// literal in lib/ or app/ that is in neither this list nor API_HOSTS - so every new host is classified explicitly.
export const NON_REQUEST_HOSTS: Record<string, string> = {
  'dazl.ai': 'own domain (user-agent string, links)',
  'staging.dazl.ai': 'own domain',
  'docs.github.com': 'documentation link',
  'docs.anthropic.com': 'documentation link',
  'developers.openai.com': 'documentation link in a comment',
  'docs.tinyfish.ai': 'documentation link',
  'docs.peopledatalabs.com': 'documentation link',
  'docs.apollo.io': 'documentation link',
  'console.anthropic.com': 'documentation link',
  'platform.openai.com': 'documentation link',
  'platform.claude.com': 'documentation link',
  'www.gdeltproject.org': 'citation link GDELT terms require; the API host is api.gdeltproject.org',
  'blog.gdeltproject.org': 'documentation link in a comment',
  'www.sec.gov': 'evidence link to the EDGAR filing page; the search API is efts.sec.gov and filing pages are read through the page reader',
  'www.linkedin.com': 'constructed profile/company links; the optional advanced connector reads LinkedIn through the customer\'s own signed-in session, not this server',
  'www.youtube.com': 'evidence links to videos; data comes from the YouTube Data API (www.googleapis.com)',
  'news.ycombinator.com': 'evidence and directory links; search goes through hn.algolia.com',
  'boards.greenhouse.io': 'board URLs are parsed and translated to boards-api.greenhouse.io, never fetched',
  'jobs.lever.co': 'board URLs are parsed and translated to api.lever.co, never fetched',
  'jobs.ashbyhq.com': 'board URLs are parsed and translated to api.ashbyhq.com, never fetched',
  'cal.com': 'booking-link detection pattern, never fetched',
  'calendly.com': 'booking-link detection pattern, never fetched',
  'www.crtc.gc.ca': 'guidance link in a comment',
  'acme.com': 'documentation example',
  'example.com': 'documentation example',
  'www.google.com': 'static SEO directory suggestion data (lib/seo/directories.ts)',
  'www.yelp.com': 'static SEO directory suggestion data (lib/seo/directories.ts)',
  'www.yellowpages.com': 'static SEO directory suggestion data (lib/seo/directories.ts)',
  'www.webwiki.com': 'static SEO directory suggestion data (lib/seo/directories.ts)',
  'www.trustradius.com': 'static SEO directory suggestion data (lib/seo/directories.ts)',
  'www.toolify.ai': 'static SEO directory suggestion data (lib/seo/directories.ts)',
  'www.startupranking.com': 'static SEO directory suggestion data (lib/seo/directories.ts)',
  'www.sourceforge.net': 'static SEO directory suggestion data (lib/seo/directories.ts)',
  'www.softwareadvice.com': 'static SEO directory suggestion data (lib/seo/directories.ts)',
  'www.sideprojectors.com': 'static SEO directory suggestion data (lib/seo/directories.ts)',
  'www.showmelocal.com': 'static SEO directory suggestion data (lib/seo/directories.ts)',
  'www.reddit.com': 'static SEO directory suggestion data (lib/seo/directories.ts); the optional advanced connector reads Reddit through the customer\'s own session',
  'www.producthunt.com': 'static SEO directory suggestion data (lib/seo/directories.ts)',
  'www.openstreetmap.org': 'static SEO directory suggestion data (lib/seo/directories.ts)',
  'www.nextdoor.com': 'static SEO directory suggestion data (lib/seo/directories.ts)',
  'www.manta.com': 'static SEO directory suggestion data (lib/seo/directories.ts)',
  'www.killerstartups.com': 'static SEO directory suggestion data (lib/seo/directories.ts)',
  'www.joeant.com': 'static SEO directory suggestion data (lib/seo/directories.ts)',
  'www.insidr.ai': 'static SEO directory suggestion data (lib/seo/directories.ts)',
  'www.hotfrog.com': 'static SEO directory suggestion data (lib/seo/directories.ts)',
  'www.getapp.com': 'static SEO directory suggestion data (lib/seo/directories.ts)',
  'www.g2.com': 'static SEO directory suggestion data (lib/seo/directories.ts)',
  'www.futuretools.io': 'static SEO directory suggestion data (lib/seo/directories.ts)',
  'www.f6s.com': 'static SEO directory suggestion data (lib/seo/directories.ts)',
  'www.elocal.com': 'static SEO directory suggestion data (lib/seo/directories.ts)',
  'www.easywithai.com': 'static SEO directory suggestion data (lib/seo/directories.ts)',
  'www.cybo.com': 'static SEO directory suggestion data (lib/seo/directories.ts)',
  'www.crunchbase.com': 'static SEO directory suggestion data (lib/seo/directories.ts)',
  'www.chamberofcommerce.com': 'static SEO directory suggestion data (lib/seo/directories.ts)',
  'www.capterra.com': 'static SEO directory suggestion data (lib/seo/directories.ts)',
  'www.brownbook.net': 'static SEO directory suggestion data (lib/seo/directories.ts)',
  'www.bingplaces.com': 'static SEO directory suggestion data (lib/seo/directories.ts)',
  'www.bbb.org': 'static SEO directory suggestion data (lib/seo/directories.ts)',
  'wellfound.com': 'static SEO directory suggestion data (lib/seo/directories.ts)',
  'venturebeat.com': 'static SEO directory suggestion data (lib/seo/directories.ts)',
  'topai.tools': 'static SEO directory suggestion data (lib/seo/directories.ts)',
  'theresanaiforthat.com': 'static SEO directory suggestion data (lib/seo/directories.ts)',
  'supertools.therundown.ai': 'static SEO directory suggestion data (lib/seo/directories.ts)',
  'stackshare.io': 'static SEO directory suggestion data (lib/seo/directories.ts)',
  'startupbuffer.com': 'static SEO directory suggestion data (lib/seo/directories.ts)',
  'startupbase.io': 'static SEO directory suggestion data (lib/seo/directories.ts)',
  'indiehackers.com': 'static SEO directory suggestion data (lib/seo/directories.ts)',
  'futurepedia.io': 'static SEO directory suggestion data (lib/seo/directories.ts)',
  'foursquare.com': 'static SEO directory suggestion data (lib/seo/directories.ts)',
  'eu-startups.com': 'static SEO directory suggestion data (lib/seo/directories.ts)',
  'betalist.com': 'static SEO directory suggestion data (lib/seo/directories.ts)',
  'alternativeto.net': 'static SEO directory suggestion data (lib/seo/directories.ts)',
  'aixploria.com': 'static SEO directory suggestion data (lib/seo/directories.ts)',
  'aitoolsdirectory.com': 'static SEO directory suggestion data (lib/seo/directories.ts)',
  'botw.org': 'static SEO directory suggestion data (lib/seo/directories.ts)',
  'techcrunch.com': 'static publication-list data (lib/scan/source-quality.ts), never fetched',
}

// Every source the capability matrix ships (lib/sources/capability-matrix.ts) mapped to the name the policy text
// uses for it. The test requires an exact match between shipped ids and these keys, and each name in the text.
export const PUBLIC_SOURCES: Record<string, string> = {
  rss: 'RSS/Atom feeds you supply',
  github: 'GitHub',
  web: 'company websites and public pages',
  v2ex: 'V2EX',
  youtube: 'YouTube',
  jobboards: 'job boards (Greenhouse, Lever, Ashby)',
  'sec-form-d': 'SEC EDGAR',
  brreg: 'Brønnøysundregistrene',
  'companies-house': 'Companies House (UK)',
  'adv:x': 'X',
  'adv:reddit': 'Reddit',
  'adv:instagram': 'Instagram',
  'adv:bilibili': 'Bilibili',
  'adv:linkedin': 'LinkedIn',
}

export interface Section { heading: string; paragraphs: string[] }

const list = (xs: readonly string[]) => xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`
const ai = list(Object.values(FACTS.aiVendors))
const enrich = list(Object.values(FACTS.enrichmentProviders))
const crm = list(Object.values(FACTS.crmProviders))
const P = OWNER_PLACEHOLDERS

export const PRIVACY: Section[] = [
  { heading: 'Who we are', paragraphs: [
    `Last updated: ${P.lastUpdated}. ${P.legalName}, ${P.companyRegistration} ("dazl", "we"), operates dazl.ai. Privacy questions and requests: ${P.privacyContact}.`,
  ] },
  { heading: 'What we collect about you (customers)', paragraphs: [
    'Account details: your name, email address, optional business name, and a salted scrypt hash of your password (never the password itself). If you sign in with Google, the email address and account identifier Google returns.',
    'Session records: a hash of each sign-in token, a coarse device label such as "Chrome on macOS" (the raw browser header is not stored), and when the session was last used.',
    `Credentials you give us: AI provider keys, enrichment and CRM keys, and your Gmail authorization. These are stored encrypted (AES-256-GCM, with a key held only in the server environment); the secrets themselves are never included in a data export.`,
    'Your business profile, the prospects your searches find, the drafts and messages you send, and replies dazl reads (see Gmail below).',
  ] },
  { heading: 'What we hold about prospects', paragraphs: [
    'dazl finds businesses and business contacts from public sources: company websites, job boards, SEC filings, official business registers, GitHub, news and community sites. Each lead keeps the link to the page it came from.',
    `Where you connect your own ${enrich} account, contact details those providers return under your key are added to your leads. With the optional advanced connector, results from LinkedIn and social sites (X, Reddit, Instagram, Facebook, Xiaohongshu, Bilibili) come through your own signed-in session.`,
    `When ${FACTS.emailGuessFlag} is turned on, dazl works out a company's address format from personal addresses it publishes on its own site and prepares candidate addresses for people listed there. Those candidates are stored apart from your leads, marked unverified, and are never shown to you or emailed. When a ZeroBounce key is configured, a candidate for a company whose own site states a US address may be sent to ZeroBounce to check whether the mailbox accepts mail (no email is sent to it); only an explicit "valid" answer is recorded as verified, and a catch-all domain never is. [NEEDS OWNER: update this text before mailbox-verified guessed addresses ship (DECISIONS.md 2026-10-26: US recipients only).]`,
    'When dazl could not read a page itself and verified a lead against a copy of its text, that copy is kept with the lead and expires after ' + `${FACTS.evidenceCopyRetainDays} days.`,
    'Prospect records your searches find - leads, enrichments, drafts and scans - belong to the customer whose search found them: tenant scoping, pinned by the isolation tests, serves them only to that workspace, and no route serves one customer\'s leads to another. Separately, when an email address becomes a verified dazl signup, activation or payment, dazl processes that exact address across workspaces: it drops the address from every customer\'s autopilot candidates, stops that address\'s pending automated sequences, follow-ups and held first touches in every customer\'s workspace, starts the contacting customer\'s own onboarding path for it where that customer has opted in, and refuses automated sends to it. The contacting customer sees only a generic policy stop: the conversion kind (signup, activation or payment) does not appear in their stop reasons, lists or data exports. Proof previews emailed to a prospect are bound to the recipient address until claimed. No prospect names, companies or leads cross workspaces. [NEEDS COUNSEL: whether dazl acts as controller or processor for prospect data, and the lawful basis for each jurisdiction.]',
  ] },
  { heading: 'How we use it', paragraphs: [
    'To run your account, find and score prospects, draft outreach, send the messages you approve (or that autopilot sends under the limits you turned on), keep the service secure, and bill you.',
    `Page text about prospects and your business profile are sent to the AI model provider (${ai}) whose key the request runs on to score leads and write drafts. If the free trial is enabled, trial scans run on dazl's own Anthropic key; everything else runs on the key you saved.`,
  ] },
  { heading: 'Gmail', paragraphs: [
    'Outreach is sent from your own Gmail account. Connecting it grants send access only (gmail.send).',
    'Reading replies is a separate, optional grant (gmail.readonly). With it, dazl reads the new text of replies in threads it started for you (quoted history is dropped), classifies each reply by rules, and stores the sender, the Gmail message and thread identifiers, a 200-character excerpt, the classification and the received time, shown in your Inbox. It also searches a bounded, consent-disclosed window of mailer-daemon and postmaster delivery-failure notices beyond its own threads and keeps only notices matched to a recorded send; an unmatched notice leaves only its message and thread identifiers, received time and classification. Stored reply records are not deleted automatically today; turning reading off stops future reads and follow-ups but does not delete what is already stored, and deleting your account deletes them with your other workspace data, unless the deletion request asks to keep named tables (sign-in and payment credentials are always erased; the append-only audit records listed under Retention always stay). [NEEDS OWNER: retention period for stored reply records.] dazl reads nothing without this consent. [NEEDS OWNER: Google API Services User Data Policy / Limited Use statement wording.]',
  ] },
  { heading: 'Service providers', paragraphs: [
    `Google (sign-in and Gmail), Stripe (payments; card details are entered at Stripe, not on dazl), Anthropic (AI models, and the free trial when it is enabled), TinyFish (web search and page fetching), Jina AI Reader (reading public pages), and ZeroBounce (checking whether a prepared work address accepts mail; only while the address-format feature below is on and an operator key is set, at most its free monthly allowance). Hosting: ${FACTS.hostingProvider} at the current deployment [NEEDS OWNER: re-check at launch]. Account emails such as password resets: ${P.systemMailProvider}. Unless a system email provider is configured (none is by default), account emails are not sent and are held on the host. The ${FACTS.systemMailOutboxRetainHours}-hour deletion under Retention applies only once ${FACTS.accountHistoryFlag} is turned on (off by default). [NEEDS OWNER: choose the provider before account emails are enabled, turn retention on with it, and confirm both at launch.]`,
    `Providers you choose and connect with your own account or key: ${ai} (AI models), ${enrich} (contact enrichment), and ${crm} (lead export to your CRM). Their use of the data is governed by your agreement with them.`,
    'Public sources dazl queries receive the search terms it sends - a company or industry name, and for the Norwegian business register and UK Companies House a place and industry filter (a term can be personal data when it names a person) - and no account data: company websites and public pages, GitHub, job boards (Greenhouse, Lever, Ashby), the GDELT news index, Hacker News search, SEC EDGAR, the Norwegian business register (Brønnøysundregistrene), Companies House (UK), RSS/Atom feeds you supply, YouTube (through the YouTube Data API), V2EX topics (read directly and through the sov2ex search service), and public job feeds such as We Work Remotely.',
    'Error reports, if an error-monitoring service is configured, carry only the error type, code locations and a request id: never messages, account identifiers, request bodies or personal data. The server\'s own error log keeps the fuller scrubbed record, including the scrubbed message.',
    '[NEEDS COUNSEL: the sale/share statement privacy laws such as CCPA/CPRA require; no assertion is made until then.]',
  ] },
  { heading: 'Retention', paragraphs: [
    `Signed-out and expired sessions are kept for ${FACTS.revokedSessionRetainDays} days (to show who signed a device out, and when), then deleted. Undelivered account emails held while email sending is not configured are deleted after ${FACTS.systemMailOutboxRetainHours} hours. [NEEDS OWNER: both deletions run only once ${FACTS.accountHistoryFlag}=1 is set in production; confirm before publishing.]`,
    `Your workspace's audit trail (security, billing, sending and consent actions) is kept until a retention period is chosen; no audit record is deleted automatically today. [NEEDS OWNER: set ${FACTS.auditRetentionFlag}, at least ${FACTS.auditRetentionMinDays} days.]`,
    'Debug copies of scan inputs and outputs are recorded only if trace capture is turned on, and deleted only under a retention period someone chose. [NEEDS OWNER: confirm ' + `${FACTS.traceCaptureFlag} is off in production, or disclose its period.]`,
    'Other account and lead data is kept while your account exists. [NEEDS OWNER: retention for an active account\'s leads and messages, and for backups (not yet implemented).]',
  ] },
  { heading: 'Deleting your account', paragraphs: [
    `You can download an export of your workspace data in Settings (it asks you to confirm it is you). To delete your data, ask us at ${P.privacyContact}: self-service deletion is not switched on in the current service configuration. The Settings page shows whether deletion is available, and where it is switched on it offers the control, which asks for the workspace id as confirmation and a decision on the opt-out list. A deletion removes credentials and sign-in state first, then queued work, then the rest of your workspace data, except what the deletion request names to keep (never credentials) and the records listed below. It deletes dazl's stored Gmail tokens; the grant in your Google account is separate, and you can remove dazl's access there at any time.`,
    `Some records survive deletion because they contain no message content: the audit trail, the record of evidence purges, and consent records. A consent record holds the internal account ID, the action and its time; while your account exists it also holds a short note (the consent policy version or the conversion type). Blanking that note is part of the deletion's final step: the deletion is not marked complete until the note is blank. If that final step fails, the earlier erasure is not undone and completion must be retried (a retry can fail again). Records from before this safeguard are blanked by a scheduled cleanup job when it runs - if a run is delayed or fails, their note stays until a later successful run, so for those older records there is no guaranteed moment by which it is gone. Once ${FACTS.consentProofRetainYears} years have passed since the deletion completed, the same scheduled cleanup job deletes the consent records in batches on its successful runs, so the last record can go later than that. [NEEDS COUNSEL: confirm the ${FACTS.consentProofRetainYears}-year period, chosen by the owner as a practical window, not from a statute.]`,
    '[NEEDS OWNER: whether opt-out (unsubscribe) lists are kept or erased on deletion, billing-record retention, and a grace period before erasure (docs/TENANT-LIFECYCLE.md decisions 1, 2 and 5).]',
  ] },
  { heading: 'Your rights', paragraphs: [
    `You can ask to access, correct or delete your data at ${P.privacyContact}. [NEEDS COUNSEL: which rights apply by jurisdiction (GDPR, UK GDPR, CCPA/CPRA, PIPEDA) and response times.]`,
  ] },
  { heading: 'Outbound email and opting out', paragraphs: [
    'Every outreach message dazl sends to a prospect (first touch, sequence step, follow-up or re-open) ends with the sender\'s name, a mailing address and an unsubscribe link, and carries a one-click List-Unsubscribe header. dazl refuses to send to a prospect until the sender has saved a name and a mailing address.',
    'An unsubscribe works at once, with no login: the address is added to that sender\'s opt-out list, any drafts or approved messages to it are skipped, and follow-up sequences to it stop. It is never emailed again by that sender through dazl. A bounce is handled the same way.',
    'If you received a message through dazl and want your data removed from the sender\'s workspace, ask the sender, or contact us at ' + `${P.privacyContact}.`,
    '[NEEDS COUNSEL: CASL / CAN-SPAM / PECR / GDPR applicability. These features are not a claim that any particular message complies.]',
  ] },
]

export const TERMS: Section[] = [
  { heading: 'Agreement', paragraphs: [
    `Last updated: ${P.lastUpdated}. These terms are between you and ${P.legalName}, ${P.companyRegistration}. [NEEDS COUNSEL: how acceptance is recorded at sign-up.]`,
  ] },
  { heading: 'The service', paragraphs: [
    'dazl finds prospects from public sources, shows the source for each one, and drafts outreach with AI models. You are the sender of the messages you approve and send, and you are responsible for them.',
    'Autopilot, if you turn it on, sends first-touch emails from your Gmail without asking you each time, within the daily limits you set and only after your first sends were approved by you. You can pause it at any time, and pausing stops sends before the next send; a send already handed to Gmail cannot be recalled. [NEEDS OWNER: the autopilot consent text users accepted still says \'Pausing stops sends immediately\' - an overpromise next to this behavior; changing an accepted consent text is a consent-version decision, not copy repair.]',
  ] },
  { heading: 'AI-generated content', paragraphs: [
    'Lead scores, summaries and drafts are produced by AI models and can be wrong. Check the cited source and the draft before you send. dazl does not add an AI-generated label to prospect messages: dazl adds your name, your mailing address and an unsubscribe link to your draft. [NEEDS COUNSEL: whether any recipient jurisdiction requires such a disclosure.]',
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
