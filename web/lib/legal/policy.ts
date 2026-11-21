// Public Terms of Service and Privacy Policy text (#535, #1428). The pages in app/terms and app/privacy render only what
// is here, and test/legal-policy.test.ts holds every fact below to the code that implements it (retention constants,
// providers, opt-out handling, outbound footer). Change the code and that test fails until this text is changed too.
//
// This file is deliberately import-free (it is bundled into public pages): the values are copied here and the test
// compares them with the real constants.
//
// #1428 (owner decision 2026-11-20): plain English for customers. No draft banner, no bracketed open decisions, no
// environment-variable names, no repository paths, no implementation detail in the text (test/legal-policy.test.ts
// enforces it). Each sentence still describes only what the software does today. Owner's lawyer signs off before merge.

// Owner-supplied facts that are not in the code. legalName, licence and privacyContact: owner-confirmed 2026-11-06 (#535)
// and checked against the Ajman Free Zone licence and Commercial Registry. lastUpdated: set with the #1428 rewrite.
export const OWNER_FACTS = {
  legalName: 'Mathematricks - F.Z.E',
  companyRegistration: 'a Free Zone Establishment in the Ajman Free Zone, United Arab Emirates (licence no. 47839)',
  lastUpdated: '21 November 2026',
  privacyContact: 'privacy@dazl.ai',
  systemMailProvider: 'Amazon SES',
} as const

// Facts held to the code by test/legal-policy.test.ts. The comment on each names its source. The *Flag entries are
// code-side only (the test checks the gate against the code); they never appear in the customer text (#1428).
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
  hostingProvider: 'Amazon Web Services', // reviewer-verified production instance metadata, 2026-11-04 (#613): AWS EC2, us-east-2
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
  'openrouter.ai': { name: 'OpenRouter', role: 'provider' }, // MISSION v2 research engine (lib/research/decider.ts): the free decision model that screens public search results; titles, snippets and URLs of public pages only, and only with LEAD_ENGINE=research
  'api.fetch.tinyfish.ai': { name: 'TinyFish', role: 'provider' },
  'r.jina.ai': { name: 'Jina AI (Reader)', role: 'provider' },
  'api.apollo.io': { name: 'Apollo', role: 'customer_provider' },
  'api.peopledatalabs.com': { name: 'People Data Labs', role: 'customer_provider' },
  'api.zerobounce.net': { name: 'ZeroBounce', role: 'provider' }, // #899: mailbox check of a guessed US work address; only with EMAIL_GUESS_ENABLED and an operator key
  'api.telegram.org': { name: 'Telegram', role: 'provider' }, // #1088: operator alerts only, and only when OPS_ALERT_WEBHOOK_URL is a Telegram bot URL: the scrubbed error summary (lib/ops/errors.ts alertText), never customer content
  'api.hubapi.com': { name: 'HubSpot', role: 'customer_provider' },
  'api.pipedrive.com': { name: 'Pipedrive', role: 'customer_provider' },
  'api.github.com': { name: 'GitHub', role: 'public_source' },
  'boards-api.greenhouse.io': { name: 'Greenhouse job boards', role: 'public_source' },
  'api.lever.co': { name: 'Lever job boards', role: 'public_source' },
  'api.eu.lever.co': { name: 'Lever job boards', role: 'public_source' }, // EU-hosted Lever boards (lib/research/sources/ats-boards.ts)
  'api.ashbyhq.com': { name: 'Ashby job boards', role: 'public_source' },
  'api.gdeltproject.org': { name: 'GDELT news index', role: 'public_source' },
  'data.brreg.no': { name: 'Brønnøysundregistrene (Norway business register API)', role: 'public_source' },
  'api.company-information.service.gov.uk': { name: 'Companies House (UK company register API)', role: 'public_source' },
  'find-and-update.company-information.service.gov.uk': { name: 'Companies House (UK company register pages)', role: 'public_source' },
  'www.sov2ex.com': { name: 'sov2ex (V2EX topic search)', role: 'public_source' },
  'www.v2ex.com': { name: 'V2EX', role: 'public_source' },
  'hn.algolia.com': { name: 'Hacker News search', role: 'public_source' },
  'efts.sec.gov': { name: 'SEC EDGAR', role: 'public_source' },
  'www.sec.gov': { name: 'SEC EDGAR', role: 'public_source' }, // filing documents (primary_doc.xml) read by lib/research/sources/sec-form-d.ts
  'data.austintexas.gov': { name: 'Austin (City of Austin open data, building permits)', role: 'public_source' }, // lib/research/sources/socrata-permits.ts
  'opendata.vancouver.ca': { name: 'Vancouver (City of Vancouver open data, business licences)', role: 'public_source' }, // lib/research/sources/opendatasoft-licences.ts
  'weworkremotely.com': { name: 'We Work Remotely (public job feed)', role: 'public_source' },
  'www.wikidata.org': { name: 'Wikidata (company official website)', role: 'public_source' }, // #1122 lib/connectors/free-site-finder.ts: the lead's company NAME only
  'nominatim.openstreetmap.org': { name: 'OpenStreetMap Nominatim (business website tag)', role: 'public_source' }, // #1122 lib/connectors/free-site-finder.ts: the lead's company name and the request's place only
  'html.duckduckgo.com': { name: 'DuckDuckGo HTML search (company website lookup)', role: 'public_source' }, // #1122 lib/connectors/free-site-finder.ts last step: the lead's company name and the request's place only
}

// Hosts the code names but NEVER calls, each with the reason. test/legal-policy.test.ts fails on any https://host
// literal in lib/ or app/ that is in neither this list nor API_HOSTS - so every new host is classified explicitly.
export const NON_REQUEST_HOSTS: Record<string, string> = {
  'dazl.ai': 'own domain (user-agent string, links)',
  'staging.dazl.ai': 'own domain',
  'docs.github.com': 'documentation link',
  'github.com': 'link to the dazl Connect extension install steps (a page the user opens; dazl requests nothing there)',
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
  'x.com': 'constructed profile links for people whose public posts the search index returned (research engine, person-first source); never requested',
  'www.linkedin.com': 'constructed profile/company links; the optional advanced connector reads LinkedIn through the customer\'s own signed-in session, not this server',
  'www.youtube.com': 'evidence links to videos; data comes from the YouTube Data API (www.googleapis.com)',
  'news.ycombinator.com': 'evidence and directory links; search goes through hn.algolia.com',
  'boards.greenhouse.io': 'board URLs are parsed and translated to boards-api.greenhouse.io, never fetched',
  'job-boards.greenhouse.io': 'posting URLs are parsed and translated to boards-api.greenhouse.io, never fetched',
  'jobs.lever.co': 'board and posting URLs are parsed and translated to api.lever.co (EU boards: jobs.eu.lever.co -> api.eu.lever.co), never fetched',
  'jobs.ashbyhq.com': 'board and posting URLs are parsed and translated to api.ashbyhq.com, never fetched',
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
  careers: 'careers pages on company websites',
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
const P = OWNER_FACTS
const WHO = `Last updated: ${P.lastUpdated}. dazl is a product of ${P.legalName}.`

export const PRIVACY: Section[] = [
  { heading: 'Who we are', paragraphs: [
    `${WHO} ${P.legalName} is ${P.companyRegistration}, and runs dazl.ai ("dazl", "we"). Questions and requests about your data: ${P.privacyContact}.`,
  ] },
  { heading: 'What we keep about you', paragraphs: [
    'Your name, email address, business name and password (stored in a form that cannot be read back). If you sign in with Google, the email address and account ID Google gives us.',
    'For each signed-in device: when it was last used and a short label such as "Chrome on macOS".',
    `Keys and connections you add (AI, contact-data or CRM keys, and your Gmail authorization), stored encrypted. They are never included in a data export.`,
    'Your business profile, the leads your searches find, your drafts and sent messages, and the replies dazl reads for you.',
  ] },
  { heading: 'What we keep about prospects', paragraphs: [
    'dazl finds businesses and business contacts in public sources and keeps the link to the page each lead came from. If dazl had to check a lead against a saved copy of a page, that copy expires after ' + `${FACTS.evidenceCopyRetainDays} days.`,
    `If you connect your own contact-data account (${enrich}), the details it returns to you are added to your leads.`,
    'For US companies only, dazl may work out a company\'s email format from addresses on its own site or already confirmed in your workspace. Candidate addresses are kept apart from your leads, marked unverified, and are never emailed or used as a recipient. One is shown only for a buyer whose own site prints no address, labelled "guessed, unverified" (or "guessed, verified" after a ZeroBounce mailbox check, which sends no email), and is not offered for copying until verified.',
    'Leads, drafts and scans belong to the workspace whose search found them and are never shown to another customer. One thing works across workspaces: when an email address becomes a dazl customer, dazl drops that address from every workspace\'s autopilot candidates, stops that address\'s pending automated sequences, follow-ups and held first touches in every workspace, starts the contacting customer\'s own onboarding steps for it, only where that customer turned them on, and refuses automated sends to it. The other customer sees only a generic policy stop: the conversion kind (signup, activation or payment) does not appear in their stop reasons, lists or data exports. A proof preview emailed to a prospect is bound to the recipient address until claimed.',
  ] },
  { heading: 'How we use it', paragraphs: [
    'To run your account, find and rank prospects, draft outreach, send the messages you approve or autopilot sends, and keep the service secure.',
    `To rank leads and write drafts, page text and your business profile are sent to the AI provider (${ai}) whose key the request runs on. When the free trial is on, its scans run on dazl's own Anthropic key.`,
  ] },
  { heading: 'Gmail', paragraphs: [
    'Outreach is sent from your own Gmail. Connecting it gives dazl send access only (gmail.send).',
    'Reading replies is a separate, optional grant (gmail.readonly), and dazl reads nothing without this consent. With it, dazl reads new replies in the threads it started for you, classifies each reply by rules, and keeps the sender, the Gmail message and thread identifiers, a 200-character excerpt, the classification and the received time. It also checks delivery-failure notices beyond its own threads, within a limited time window, and keeps only those that match a message it sent; an unmatched notice leaves only its message and thread identifiers, received time and classification.',
    'Stored replies are not deleted automatically today; turning reading off stops future reads and follow-ups but does not delete what is already stored; deleting your account deletes them with your other workspace data, unless the deletion request asks to keep them.',
  ] },
  { heading: 'Who else handles data', paragraphs: [
    `Running the service: Amazon Web Services (hosting, and ${P.systemMailProvider} for account emails such as password resets), Google (sign-in and Gmail), Anthropic (AI, and the free trial when it is enabled), TinyFish (web search and page reading), Jina AI Reader (reading public pages), Stripe (payments), OpenRouter (only titles, snippets and links of public search results) and ZeroBounce (mailbox checks, as above).`,
    `Accounts you connect with your own key: ${ai} (AI), ${enrich} (contact data) and ${crm} (sending leads to your CRM). Your agreement with them covers their use.`,
    'Public sources receive only the search terms dazl sends (such as a company name, place or date range), never your account data: company websites and public pages, careers pages on company websites, job boards (Greenhouse, Lever, Ashby), We Work Remotely, the GDELT news index, Hacker News search, SEC EDGAR, Companies House (UK), Brønnøysundregistrene (the Norwegian business register), city open-data portals (Austin building permits, Vancouver business licences), GitHub, YouTube, V2EX (also through the sov2ex search), RSS/Atom feeds you supply, and, to find a company\'s own website, Wikidata, OpenStreetMap and DuckDuckGo. With the optional browser connector, results from LinkedIn, X, Reddit, Instagram and Bilibili come through your own signed-in session.',
    'Error reports and alerts to our own team (for example by Telegram) carry only the error type, where it happened and a request id: never messages, account identifiers, request bodies or personal data. Our own server log keeps a fuller record with personal data removed.',
  ] },
  { heading: 'How long we keep it', paragraphs: [
    'Your account data and leads are kept while your account exists. Security, billing, sending and consent records (the audit trail) are not deleted automatically today.',
  ] },
  { heading: 'Your data and deleting your account', paragraphs: [
    `You can download an export of your workspace data in Settings. You can ask to see, correct or delete your data at ${P.privacyContact}. The Settings page shows whether you can delete your account yourself; if not, email us.`,
    'A deletion removes keys and sign-in data first, then queued work, then the rest of your workspace data, except what the deletion request names to keep (never credentials) and the records listed below. It deletes dazl\'s stored Gmail tokens; the grant in your Google account is separate, and you can remove it there at any time.',
    `A few records are kept because they contain no message content: the audit trail, the record of evidence purges, and consent records (the account ID, the action and its time). The short note on a consent record is cleared as part of the deletion, which is not marked complete until the note is blank. If that last step fails, what was already erased is not restored, and the step has to be run again. For records from before this safeguard, older records are cleared by a scheduled cleanup when it runs; if a run is late or fails, they stay until a later run. Once ${FACTS.consentProofRetainYears} years have passed since the deletion completed, a scheduled cleanup deletes the consent records.`,
  ] },
  { heading: 'Emails to prospects and opting out', paragraphs: [
    'Every outreach message dazl sends to a prospect (first touch, sequence step, follow-up or re-open) ends with the sender\'s name, a mailing address and an unsubscribe link, and has a one-click unsubscribe header. dazl will not send until the sender has saved a name and mailing address.',
    'An unsubscribe works at once, with no login: that sender never emails the address through dazl again, and any pending messages and sequences to it stop. A bounce works the same way.',
    `If you received a message through dazl and want your data removed, ask the sender or write to ${P.privacyContact}.`,
  ] },
]

export const TERMS: Section[] = [
  { heading: 'Agreement', paragraphs: [
    `${WHO} These terms are between you and ${P.legalName}, ${P.companyRegistration}. By creating an account you agree to them.`,
  ] },
  { heading: 'The service', paragraphs: [
    'dazl finds prospects in public sources, shows the source for each one, and drafts outreach with AI. You are the sender of the messages you approve and send, and you are responsible for them.',
    'If you turn on autopilot, it sends first emails from your Gmail without asking you each time, within the daily limits you set and only after your first sends were approved by you. You can pause it at any time: pausing stops sends before the next send, but a message already handed to Gmail cannot be recalled.',
  ] },
  { heading: 'AI content', paragraphs: [
    'Lead rankings, summaries and drafts are written by AI and can be wrong. Check the source and the draft before you send. dazl does not add an AI-generated label to prospect messages; it adds your name, your mailing address and an unsubscribe link.',
  ] },
  { heading: 'Acceptable use', paragraphs: [
    'No spam, no bought lists, no messages to people who asked to stop, and nothing illegal or misleading. You must follow the anti-spam and privacy laws that apply to you and the people you contact.',
  ] },
  { heading: 'Price', paragraphs: [
    `dazl is free during the beta. When the free trial is on, a new account gets free trial scans with no card; after that, scans run on an AI provider account you connect, up to ${FACTS.freeScansPerMonth} a month. A paid plan, where offered, is optional and shows its price before you pay. If you connect your own AI, contact-data or CRM account, that provider bills you for its use; cost figures dazl shows for them are estimates.`,
  ] },
  { heading: 'Beta, liability and ending your account', paragraphs: [
    'dazl is a beta. It is provided as is, without warranties, and you use it at your own risk. We may change or stop features, and we may suspend accounts that break these terms. You can stop using dazl and ask us to delete your account at any time. These terms are governed by the laws of the United Arab Emirates.',
  ] },
]
