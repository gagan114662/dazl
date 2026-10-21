# Roadmap: closing the gap to Gojiberry

The bar is Gojiberry: signal variety (LinkedIn engagement, job changes, funding, site visitors),
waterfall enrichment, multichannel outreach, a unified inbox with drafted replies, continuous 24/7
monitoring, CRM sync (HubSpot/Pipedrive/Attio/API/MCP) and a learning loop.

Where dazl is already ahead:

- **Verified evidence.** Every lead carries a source URL, a verbatim quote and a date, and the
  verifier drops anything the cited page does not support. Competitors ship unverified guesses.
- **Consent and trust.** Explicit consent ledger, suppression, unsubscribe, at-most-once sending,
  honest channel statuses, no paid data broker anywhere.

The gaps, in the order we are closing them. No paid APIs anywhere in this plan.

## 1. Continuous monitoring (in progress)

Scheduled re-scans of a saved search, change detection against what the user has already seen,
new-lead alerts in the app, and per-user caps so monitoring cannot burn the monthly quota.

- Monitors run through the same scan pipeline and the same verifier; a monitor run counts as a scan.
- Cadence is capped per plan (free: daily at most), monitors per user are capped (free: 2), and a
  monitor pauses itself when the monthly scan quota is exhausted instead of failing scans.
- Runs are triggered by the existing scheduler tick (`/api/internal/tick`, systemd timer or cron).
- Alerts are in-app (new leads since your last visit). No alert emails until there is an explicit
  per-user opt-in for them.

## 2. More key-free signal adapters

Signal variety from public sources, same adapter contract as the Tier 0 channels (plain data in,
Evidence out, verified like everything else):

- **Funding:** press-release and funding-news pages discovered through the existing web search,
  plus funding RSS feeds the user adds.
- **Hiring / job changes:** public job-board pages (company careers pages via the contact-crawl
  site list, Greenhouse/Lever public boards are plain HTML and key-free), HN "Who is hiring".
- **Launches:** Product Hunt's public RSS, company changelog pages (user-pasted via the Jina channel).
- **Site visitors:** not key-free by any honest means. Out of scope until a first-party pixel or the
  user's own analytics exists (that is the user's own data, not scraping).

Each adapter flips to "Working" in Settings only after a live scan is seen returning verified leads
from it.

## 3. HubSpot sync

OAuth 2.0 app (HubSpot's own free OAuth, no paid API), one-way push of approved leads as contacts
with the evidence in the notes (source URL, quote, date). Push only leads the user explicitly
approves - never auto-push. Pipedrive and Attio follow the same shape later.

## 4. Reply detection and inbox (gmail.readonly)

Reply/bounce reading already exists: a separate optional gmail.readonly grant with its own consent
wording, reading only threads dazl started, storing the least data needed (opt-outs, bounces,
reply state), powering follow-up gating. What is missing is the **inbox**: a page listing replied
threads with the prospect's message and a drafted reply the user approves before sending.

**Google restricted-scope gate (required before non-test users can connect read access):**

1. In Google Cloud Console, add `gmail.readonly` to the OAuth consent screen scopes and complete
   the app information (homepage, /privacy, /terms, authorized domains). /privacy currently says
   DRAFT - it must be finalized first, and it must say what we read (only threads dazl started),
   why (stop on unsubscribe/bounce, follow up on interest) and what we store.
2. Verify the domain in Search Console and submit the OAuth app for verification, including the
   demo video showing the consent screen and exactly what is read.
3. gmail.readonly is a **restricted** scope, so Google also requires a yearly third-party security
   assessment (CASA) by an authorized assessor. This is a paid external assessment and takes weeks.
4. Until verification completes, the OAuth app stays in Testing mode: only allowlisted test users
   (max 100) can grant the scope and refresh tokens expire in 7 days. The read grant UI must say so.

The owner must do steps 1-4 (they hold the Google Cloud project). The code already keeps reads
minimal and consent separate; the privacy policy update ships with the inbox PR.

## 5. MCP / API access for dazl

Read-first public API (per-tenant API keys, scoped): list scans, list verified leads with evidence,
list monitors. Then an MCP server exposing the same reads plus "run this search" (counts as a scan).
Writes stay in the app until there is a clear consent story for API-driven outreach.
