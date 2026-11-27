// Public Terms of Service and Privacy Policy text (#535). The pages in app/terms and app/privacy render only what is
// here, and test/legal-policy.test.ts holds every fact below to the code that implements it (retention constants,
// providers, opt-out handling, outbound footer). Change the code and that test fails until this text is changed too.
//
// This file is deliberately import-free (it is bundled into public pages): the values are copied here and the test
// compares them with the real constants.
//
// Status: both texts are final. The privacy policy was finished for publication on the owner's instruction (2026-11-22).
// The terms are the plain-English free-beta terms the owner approved on 2026-11-23 (#1428, decision recorded on #1579):
// their wording is hers, so change a sentence only on a new owner decision. Neither text carries a draft label or a
// bracketed placeholder (test/legal-policy.test.ts).
// #1428 (owner decision on #1428 and #1579, 2026-11-23): the privacy policy names only the providers the service uses in
// its launch configuration (Claude only, send-only Gmail, no autopilot, no billing). A provider the code can still call
// behind an operator switch carries `off` in API_HOSTS below and is NOT named in the text; switch one on and the text
// must name it first (test/legal-policy.test.ts holds both directions).

export const POLICY_STATUS = 'final' as const   // the terms of service
export const PRIVACY_STATUS = 'final' as const
// The published privacy policy states these as facts, so production must run with them. They are off by default in the code:
// set them on the production host before the policy is deployed (test/legal-policy.test.ts holds the text to this list).
export const PRIVACY_REQUIRES_ENV = {
  ACCOUNT_RETENTION_ENABLED: '1',   // signed-out sessions deleted after 30 days, undelivered account email after 24 hours
  AUDIT_RETENTION_DAYS: '365',      // the audit trail is deleted after 365 days
  DAZL_TRACE_CAPTURE: '',           // unset: no debug copies of scans are kept
  // #1428: unset, so the providers the policy does not name are never called
  TINYFISH_ENABLED: '',             // lib/search/tinyfish.ts tinyfishEnabled: TinyFish search and fetch
  DAZL_PAID_VENDORS: '',            // lib/paid-vendors.ts: OpenAI, Apollo, People Data Labs, ZeroBounce, Jina
  DAZL_DISCOVER_LANE: '',           // lib/scan/runner.ts laneSwitchedOn: '0' would run the older engine (TinyFish, Jina, key enrichment)
  BILLING_AVAILABLE: '',            // lib/beta.ts: Stripe checkout
  AUTOPILOT_AVAILABLE: '',          // lib/beta.ts: sending without a person's approval
} as const
// The one sentence about price, used by the terms and by the homepage's free-beta card, so the two cannot differ.
export const FREE_BETA_TERMS = "dazl is free during the beta. We don't charge you anything. We'll give at least 30 days' notice by email before any paid plan starts, and nothing will be charged without you choosing a plan."

// Owner-supplied facts that are not in the code.
// legalName, companyRegistration and privacyContact: owner-confirmed 2026-11-06 (#535) and checked against the
// Ajman Free Zone licence and Commercial Registry. Only document-verified fields are used here.
// NEEDS COUNSEL: the licence activity is 'Management Consultancies'; counsel to confirm it covers operating dazl.
export const OWNER_PLACEHOLDERS = {
  legalName: 'Mathematricks - F.Z.E',
  companyRegistration: 'a Free Zone Establishment with limited liability in the Ajman Free Zone, United Arab Emirates (licence and registration no. 47839, first issued 23 July 2025; authorized capital AED 100,000), with its premises at Office C1-1F-SF11592, Ajman Free Zone C1 Building, Ajman, United Arab Emirates',
  lastUpdated: '23 November 2026',        // the privacy policy
  termsLastUpdated: '23 November 2026',   // the terms of service
  privacyContact: 'privacy@dazl.ai',
  systemMailProvider: 'Resend',   // production's SYSTEM_MAIL_SMTP_URL host is smtp.resend.com (checked 2026-11-22)
} as const

// Facts held to the code by test/legal-policy.test.ts. The comment on each names its source.
export const FACTS = {
  freeScansPerMonth: 50,                 // lib/plans.ts PLAN_LIMITS.free.scansPerMonth (the terms no longer state it: free beta, #1428)
  revokedSessionRetainDays: 30,          // lib/sessions.ts SESSION_RETAIN_S
  systemMailOutboxRetainHours: 24,       // lib/system-mail.ts OUTBOX_RETAIN_S
  accountHistoryFlag: 'ACCOUNT_RETENTION_ENABLED', // lib/account-retention.ts: sessions/outbox reaping is off unless '1'
  evidenceCopyRetainDays: 90,            // lib/scan/evidence-copies.ts RETENTION_DAYS
  consentProofRetainYears: 2,            // lib/outreach/onboarding-policy.ts ONBOARDING_AUDIT_RETAIN_YEARS (DECISIONS.md 2026-11-02)
  auditRetentionFlag: 'AUDIT_RETENTION_DAYS', // lib/audit.ts auditRetention: off (nothing purged) until set
  auditRetentionMinDays: 30,
  auditRetentionDays: 365,               // the period the published policy states; production sets AUDIT_RETENTION_DAYS to this
  traceCaptureFlag: 'DAZL_TRACE_CAPTURE', // lib/evals/capture.ts traceCaptureConfig: off unless '1'
  // lib/tenant/lifecycle.ts ALWAYS_RETAINED: kept after account deletion whatever the deletion policy
  retainedAfterDeletion: ['audit_events', 'evidence_purge_audit', 'onboarding_audit'],
  // lib/llm/vendors.ts VENDORS. The policy names Anthropic only: an OpenAI key is not offered and never used (lib/paid-vendors.ts usableVendor).
  aiVendors: { anthropic: 'Anthropic', openai: 'OpenAI' },
  // lib/enrich/index.ts. Not named in the policy: saved keys are used only by the older engine or a Pro-plan import (#1428).
  enrichmentProviders: { 'enrich:apollo': 'Apollo', 'enrich:pdl': 'People Data Labs' },
  crmProviders: { hubspot: 'HubSpot', pipedrive: 'Pipedrive', webhook: 'an HTTPS webhook you control' }, // lib/crm/index.ts
  gmailSendScope: 'https://www.googleapis.com/auth/gmail.send',     // lib/gmail/oauth.ts GMAIL_SEND_SCOPE
  gmailReadScope: 'https://www.googleapis.com/auth/gmail.readonly', // lib/gmail/oauth.ts GMAIL_READ_SCOPE: never in the default grant; the policy says dazl does not ask for it (#1428, #1603)
  emailGuessFlag: 'EMAIL_GUESS_ENABLED', // lib/people/email-pattern.ts: off unless '1'; candidates stay 'unverified', unread by outreach
  hostingProvider: 'Amazon Web Services (region us-east-2)', // reviewer-verified production instance metadata, 2026-11-04 (#613); backups: ops/backup (#1080)
} as const

// Every third-party API host the code calls (test/legal-policy.test.ts scans lib/ and app/ for api-style hosts and
// fails on one missing here), with who receives the data and why.
export type HostRole = 'provider' | 'customer_provider' | 'public_source'
// off: the operator switch (PRIVACY_REQUIRES_ENV) that must be set before the code calls this host. Production leaves it
// unset, so the policy text does not name the provider (#1428).
export const API_HOSTS: Record<string, { name: string; role: HostRole; off?: keyof typeof PRIVACY_REQUIRES_ENV }> = {
  'accounts.google.com': { name: 'Google', role: 'provider' },
  'oauth2.googleapis.com': { name: 'Google', role: 'provider' },
  'www.googleapis.com': { name: 'Google', role: 'provider' },
  'gmail.googleapis.com': { name: 'Google', role: 'provider' },
  'api.stripe.com': { name: 'Stripe', role: 'provider', off: 'BILLING_AVAILABLE' },
  'api.anthropic.com': { name: 'Anthropic', role: 'provider' },
  'us.i.posthog.com': { name: 'PostHog', role: 'provider' }, // #1616 lib/analytics/track.ts: funnel step names with counts and internal ids only; off without NEXT_PUBLIC_POSTHOG_KEY
  'api.openai.com': { name: 'OpenAI', role: 'customer_provider', off: 'DAZL_PAID_VENDORS' },
  'api.search.tinyfish.ai': { name: 'TinyFish', role: 'provider', off: 'TINYFISH_ENABLED' },
  'api.fetch.tinyfish.ai': { name: 'TinyFish', role: 'provider', off: 'TINYFISH_ENABLED' },
  'r.jina.ai': { name: 'Jina AI (Reader)', role: 'provider', off: 'DAZL_DISCOVER_LANE' },
  'api.apollo.io': { name: 'Apollo', role: 'customer_provider', off: 'DAZL_PAID_VENDORS' },
  'api.peopledatalabs.com': { name: 'People Data Labs', role: 'customer_provider', off: 'DAZL_PAID_VENDORS' },
  'api.zerobounce.net': { name: 'ZeroBounce', role: 'provider', off: 'DAZL_PAID_VENDORS' }, // #899: mailbox check of a guessed US work address; only with EMAIL_GUESS_ENABLED and an operator key
  'api.telegram.org': { name: 'Telegram', role: 'provider' }, // #1088: operator alerts only, and only when OPS_ALERT_WEBHOOK_URL is a Telegram bot URL: the scrubbed error summary (lib/ops/errors.ts alertText), never customer content
  'api.hubapi.com': { name: 'HubSpot', role: 'customer_provider' },
  'api.pipedrive.com': { name: 'Pipedrive', role: 'customer_provider' },
  'api.github.com': { name: 'GitHub', role: 'public_source' },
  'boards.greenhouse.io': { name: 'Greenhouse job posting pages', role: 'public_source' }, // board URLs use boards-api.greenhouse.io; posting URLs are fetched directly only for cited-email verification
  'job-boards.greenhouse.io': { name: 'Greenhouse job posting pages', role: 'public_source' }, // posting URLs use boards-api.greenhouse.io; fetched directly only for cited-email verification
  'jobs.lever.co': { name: 'Lever job posting pages', role: 'public_source' }, // posting URLs use api.lever.co; fetched directly only for cited-email verification
  'jobs.eu.lever.co': { name: 'Lever job posting pages', role: 'public_source' }, // posting URLs use api.eu.lever.co; fetched directly only for cited-email verification
  'jobs.ashbyhq.com': { name: 'Ashby job posting pages', role: 'public_source' }, // posting URLs use api.ashbyhq.com; fetched directly only for cited-email verification
  'boards-api.greenhouse.io': { name: 'Greenhouse job boards', role: 'public_source' },
  'api.lever.co': { name: 'Lever job boards', role: 'public_source' },
  'api.eu.lever.co': { name: 'Lever job boards', role: 'public_source' }, // EU-hosted Lever boards (lib/sources/ats-board-api.ts)
  'apply.workable.com': { name: 'Workable job boards', role: 'public_source' }, // Reads public job postings to confirm posting dates.
  'api.ashbyhq.com': { name: 'Ashby job boards', role: 'public_source' },
  'api.smartrecruiters.com': { name: 'SmartRecruiters job boards', role: 'public_source' }, // Reads public job postings to confirm posting dates.
  'api.gdeltproject.org': { name: 'GDELT news index', role: 'public_source' },
  'data.brreg.no': { name: 'Brønnøysundregistrene (Norway business register API)', role: 'public_source' },
  'api.company-information.service.gov.uk': { name: 'Companies House (UK company register API)', role: 'public_source' },
  'find-and-update.company-information.service.gov.uk': { name: 'Companies House (UK company register pages)', role: 'public_source' },
  'www.sov2ex.com': { name: 'sov2ex (V2EX topic search)', role: 'public_source' },
  'www.v2ex.com': { name: 'V2EX', role: 'public_source' },
  'hn.algolia.com': { name: 'Hacker News search', role: 'public_source' },
  'efts.sec.gov': { name: 'SEC EDGAR', role: 'public_source' },
  'www.sec.gov': { name: 'SEC EDGAR', role: 'public_source' }, // filing documents (primary_doc.xml) read by lib/research/sources/sec-form-d.ts
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
  'platform.claude.com': 'documentation link',
  'www.gdeltproject.org': 'citation link GDELT terms require; the API host is api.gdeltproject.org',
  'blog.gdeltproject.org': 'documentation link in a comment',
  'www.linkedin.com': 'constructed profile/company links; LinkedIn pages are read only in the customer\'s own browser by the dazl Connect extension, never by this server',
  'www.youtube.com': 'evidence links to videos; data comes from the YouTube Data API (www.googleapis.com)',
  'news.ycombinator.com': 'evidence and directory links; search goes through hn.algolia.com',
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
  jobboards: 'job boards (Greenhouse, Lever, Ashby, Workable, SmartRecruiters)',
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
const crm = list(Object.values(FACTS.crmProviders))
const P = OWNER_PLACEHOLDERS

export const PRIVACY: Section[] = [
  { heading: 'Who we are', paragraphs: [
    `Last updated: ${P.lastUpdated}. ${P.legalName}, ${P.companyRegistration} ("dazl", "we"), operates dazl.ai. Privacy questions and requests: ${P.privacyContact}.`,
  ] },
  { heading: 'Google user data and Limited Use', paragraphs: [
    'dazl\'s use and transfer to any other app of information received from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements.',
  ] },
  { heading: 'What we collect about you (customers)', paragraphs: [
    'Account details: your name, email address, optional business name, and a salted scrypt hash of your password (never the password itself). If you sign in with Google, the name, email address and account identifier Google returns.',
    'Session records: a hash of each sign-in token, a coarse device label such as "Chrome on macOS" (the raw browser header is not stored), and when the session was last used.',
    `Credentials you give us: your Anthropic key, any enrichment or CRM keys you save, your Gmail authorization, and any social-site session you save for the optional advanced connector. These are stored encrypted (AES-256-GCM, with a key held only in the server environment); the secrets themselves are never included in a data export.`,
    'Your business profile, the prospects your searches find, and the drafts and messages you send.',
  ] },
  { heading: 'What we hold about prospects', paragraphs: [
    'dazl finds businesses and business contacts from public sources: company websites, job boards, SEC filings, official business registers, GitHub, news and community sites. Each lead keeps the link to the page it came from.',
    `With the optional advanced connector you can save your own signed-in session for X, Reddit, Instagram, Facebook, Xiaohongshu or Bilibili; dazl stores it encrypted, and a dazl worker uses it to read those sites as you, only for the searches you run. LinkedIn is handled differently: it is read only in your own browser by the dazl Connect extension (below), and dazl's servers hold no LinkedIn session.`,
    'A contact\'s email address is shown only when dazl found that address published on a public page, and the lead keeps the link to that page. dazl does not build or guess an email address from a person\'s name; addresses that earlier versions prepared that way are not shown, never emailed and never used as a recipient.',
    'When dazl could not read a page itself and verified a lead against a copy of its text, that copy is kept with the lead and expires after ' + `${FACTS.evidenceCopyRetainDays} days.`,
    'Prospect records your searches find - leads, enrichments, drafts and scans - belong to the customer whose search found them: dazl serves them only to that workspace, and no route serves one customer\'s leads to another. Separately, when an email address becomes a verified dazl signup, activation or payment, dazl processes that exact address across workspaces: queued messages to that address that were waiting to go out without a further approval are stopped in every customer\'s workspace, and the contacting customer\'s own onboarding path starts for it where that customer has opted in. The contacting customer sees only a generic policy stop: the conversion kind (signup, activation or payment) does not appear in their stop reasons, lists or data exports. Proof previews emailed to a prospect are bound to the recipient address until claimed. No prospect names, companies or leads cross workspaces.',
    'For your own account data, dazl decides how it is used and is responsible for it. For the prospect records in your workspace, you decide what to search for and whom to contact, and dazl handles those records on your instructions. You are responsible for having a lawful reason to contact the people you find.',
  ] },
  { heading: 'How we use it', paragraphs: [
    'To run your account, find and score prospects, draft outreach, send the messages you approve, and keep the service secure.',
    'Your search request, your business profile and page text about prospects are sent to Anthropic, whose Claude models find and score leads (including the web searches and page reads the model makes for your search) and write drafts. If the free trial is enabled, trial scans run on dazl\'s own Anthropic key; everything else runs on the Anthropic key you saved.',
  ] },
  { heading: 'Gmail', paragraphs: [
    'Outreach is sent from your own Gmail account, and only the messages you approve. Connecting it grants send access only (gmail.send). dazl does not ask for access to read your mailbox and does not read your replies.',
  ] },
  { heading: 'dazl Connect browser extension', paragraphs: [
    'dazl Connect is an optional Chrome extension. If you install it and connect it from dazl Settings, it opens the LinkedIn pages your workspace asks for (company People pages, profiles and post comments) in a background tab in your own browser, using the LinkedIn account you are already signed in to there. It reads the names, job titles and profile links shown on those pages, sends them to your dazl workspace over HTTPS, and closes the tab.',
    'It does not read or send your cookies or your LinkedIn password, and dazl\'s servers do not sign in to LinkedIn as you. It does not read your browsing history or any site other than LinkedIn, and it never connects, messages, likes, follows or posts.',
    'On your device it stores only the dazl site it is paired with, a device token, and a note of what it last did. What it sends is stored in your workspace as prospect records and handled as described under "What we hold about prospects". It is not sold, not used for advertising, and not shared with anyone other than the service providers listed below.',
    'To stop: pause or disconnect in dazl Settings, choose "Forget this browser" in the extension, or remove the extension.',
  ] },
  { heading: 'Service providers', paragraphs: [
    `Google (sign-in, and sending the messages you approve from your Gmail), Anthropic (AI models, including the web searches and page reads its models make for your searches, and the free trial when it is enabled), Cloudflare (the dazl.ai domain name service, and routing of email sent to our dazl.ai addresses), and PostHog (product analytics: which steps of dazl an account reaches, such as signing up, connecting Gmail, starting a search and sending a message, with counts such as how many leads a search showed; never the names or email addresses of prospects). Hosting and backups: ${FACTS.hostingProvider}. Account emails such as password resets are sent through ${P.systemMailProvider}.`,
    `Providers you choose and connect with your own account or key: Anthropic (AI models, on your own key), and ${crm} (lead export to your CRM, only when you connect one in Settings). Their use of the data is governed by your agreement with them.`,
    'Public sources dazl queries receive the search terms it sends - a company or industry name, for the Norwegian business register and UK Companies House a place and industry filter, and for SEC EDGAR a city, state and date range (a term can be personal data when it names a person, such as the name or address of a sole trader) - and no account data: company websites and public pages, GitHub, job boards (Greenhouse, Lever, Ashby, Workable, SmartRecruiters), the GDELT news index, Hacker News search, SEC EDGAR, the Norwegian business register (Brønnøysundregistrene), careers pages on company websites, Companies House (UK), RSS/Atom feeds you supply, YouTube (through the YouTube Data API), V2EX topics (read directly and through the sov2ex search service), public job feeds such as We Work Remotely, and, to find a company\'s own website, Wikidata (the company name) OpenStreetMap\'s Nominatim search (the company name and the requested place) and, as a last step, DuckDuckGo\'s HTML search (the company name and the requested place). dazl reads public job postings on these boards to confirm posting dates.',
    'Error reports go to an error-monitoring service or, through Telegram, to the dazl team. Both carry only the error type, code locations and a request id: never messages, account identifiers, request bodies or personal data. The server\'s own error log keeps the fuller scrubbed record, including the scrubbed message.',
    'We do not sell personal information, and we do not share it for advertising. We pass it only to the service providers listed here, to do the jobs described.',
  ] },
  { heading: 'Retention', paragraphs: [
    `Signed-out and expired sessions are kept for ${FACTS.revokedSessionRetainDays} days (to show who signed a device out, and when), then deleted. Undelivered account emails held while email sending is not configured are deleted after ${FACTS.systemMailOutboxRetainHours} hours.`,
    `Your workspace's audit trail (security, billing, sending and consent actions) is kept for ${FACTS.auditRetentionDays} days, then deleted.`,
    'dazl does not keep debug copies of scan inputs and outputs in production.',
    `Other account and lead data, including your leads and messages, is kept while your account exists.`,
  ] },
  { heading: 'Deleting your account', paragraphs: [
    `You can download an export of your workspace data in Settings (it asks you to confirm it is you). To delete your data, ask us at ${P.privacyContact}: self-service deletion is not switched on in the current service configuration. The Settings page shows whether deletion is available, and where it is switched on it offers the control, which asks for the workspace id as confirmation and a decision on the opt-out list. A deletion removes credentials and sign-in state first, then queued work, then the rest of your workspace data, except what the deletion request names to keep (never credentials) and the records listed below. It deletes dazl's stored Gmail tokens; the grant in your Google account is separate, and you can remove dazl's access there at any time.`,
    `Some records survive deletion because they contain no message content: the audit trail, the record of evidence purges, and consent records. A consent record holds the internal account ID, the action and its time; while your account exists it also holds a short note (the consent policy version or the conversion type). Blanking that note is part of the deletion's final step: the deletion is not marked complete until the note is blank. If that final step fails, the earlier erasure is not undone and completion must be retried (a retry can fail again). Records from before this safeguard are blanked by a scheduled cleanup job when it runs - if a run is delayed or fails, their note stays until a later successful run, so for those older records there is no guaranteed moment by which it is gone. Once ${FACTS.consentProofRetainYears} years have passed since the deletion completed, the same scheduled cleanup job deletes the consent records in batches on its successful runs, so the last record can go later than that.`,
    'Opt-out (unsubscribe) lists are kept after deletion, so that people who asked not to be emailed stay protected. Billing records are kept for as long as tax and accounting law requires. Deletion starts when we confirm your request; there is no waiting period.',
  ] },
  { heading: 'Your rights', paragraphs: [
    `You can ask to access, correct or delete your data at ${P.privacyContact}. Depending on where you live, you may also have the right to restrict or object to how we use your data, to receive a copy in a portable format, and to complain to your data protection authority.`,
  ] },
  { heading: 'Outbound email and opting out', paragraphs: [
    'Every outreach message sent to a prospect through dazl ends with the sender\'s name, a mailing address and an unsubscribe link, and carries a one-click List-Unsubscribe header. dazl refuses to send to a prospect until the sender has saved a name and a mailing address.',
    'An unsubscribe works at once, with no login: the address is added to that sender\'s opt-out list, and any drafts or approved messages to it are skipped. It is never emailed again by that sender through dazl. A bounce is handled the same way.',
    'If you received a message through dazl and want your data removed from the sender\'s workspace, ask the sender, or contact us at ' + `${P.privacyContact}.`,
    'You are responsible for following the email and privacy laws that apply to you and to the people you contact, such as CAN-SPAM, CASL, PECR and GDPR. The features above help with that; they do not make a message compliant by themselves.',
  ] },
]

export const TERMS: Section[] = [
  { heading: 'Agreement', paragraphs: [
    `Last updated: ${P.termsLastUpdated}. These terms are between you and ${P.legalName}, ${P.companyRegistration}. dazl is a product of ${P.legalName}.`,
    'By creating an account you agree to these Terms and to the Privacy Policy.',
  ] },
  { heading: 'The service', paragraphs: [
    'dazl finds prospects from public sources, shows the source for each one, and drafts outreach with AI models. You are the sender of the messages you approve and send, and you are responsible for them.',
    'Autopilot is not available during the beta. Every message is reviewed and sent by you.',
  ] },
  { heading: 'AI-generated content', paragraphs: [
    'Lead scores, summaries and drafts are produced by AI models and can be wrong. Check the cited source and the draft before you send. dazl does not add an AI-generated label to prospect messages: dazl adds your name, your mailing address and an unsubscribe link to your draft. You are responsible for any disclosure the law where your recipient lives requires.',
  ] },
  { heading: 'Acceptable use', paragraphs: [
    'No spam, no purchased lists, no messages to people who asked to stop, no illegal or deceptive content. You must comply with the anti-spam and privacy laws that apply to you and your recipients, for example CASL in Canada, CAN-SPAM in the US, and PECR and GDPR in the UK and EU.',
  ] },
  { heading: 'Your key', paragraphs: [
    'If you connect your own Anthropic key, usage is billed to you by Anthropic. Cost figures dazl shows for that usage are estimates.',
  ] },
  { heading: 'Plans and billing', paragraphs: [
    FREE_BETA_TERMS,
  ] },
  { heading: 'Liability and termination', paragraphs: [
    'During the beta the service is provided "as is", with no warranties.',
    'Our liability to you is capped at the greater of the amounts you paid us in the last 12 months or US$100.',
    'You indemnify us for the messages you send.',
    `You can close your account at any time by writing to ${P.privacyContact}. We can suspend accounts that break the Acceptable use rules above.`,
  ] },
  { heading: 'Governing law', paragraphs: [
    'These terms are governed by the laws of Ontario, Canada. Disputes go to the courts in Toronto.',
  ] },
]
