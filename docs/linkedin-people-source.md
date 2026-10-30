# LinkedIn person-level signals: source, fields, licensing feasibility (#192)

**Status: inactive.** The code (`web/lib/signals/linkedin-people.ts`) is a gated consumer of an injected transport. No transport exists in this repository, none is configured in production, and nothing here activates it. Nothing in this change contacts LinkedIn, and no live probing was done.

## What the feature would use
A reviewed integration would provide a `LinkedInTransport` that returns, per call, **one page** (exactly one upstream request, no pagination) of either
- `people`: profiles matching a buyer role and place, or
- `engagers`: people who publicly commented on or reacted to a competitor's post.

## Source (official / public) and what is NOT verified
- **Official APIs.** LinkedIn's self-serve developer products cover signing in a member (their own name/email/photo), sharing a post as that member, and partner-gated marketing and community-management APIs. I know of **no** self-serve official API that returns people search results or a competitor post's commenter/reactor list for an arbitrary company. Sales Navigator / recruiting / marketing integrations are partner programs with their own approval and terms.
- **Member data export.** A member can download their own data. That is the member's data about themselves and their own network, not a source of market-wide leads.
- **Public pages.** LinkedIn's User Agreement restricts automated access and scraping of its pages; reading public profile pages with a robot is not assumed to be permitted.
- **Verification status: NOT verified here.** This environment has no network and no access to LinkedIn's current developer terms, so the statements above are the author's understanding and must be checked against LinkedIn's current developer terms and the relevant partner program before any transport is written. If no licensed/official source can provide these fields, the feature stays inactive.

## Allowed fields (and nothing else)
`url` (public profile `https://www.linkedin.com/in/<slug>`), `title` (a display name or headline, ≤120 chars), `quote` (one short public text, e.g. the person's own comment or headline, ≤300 chars), `date` (when it was posted, if known). No email, phone, photo, connection graph, employer history, or inferred attribute is requested, stored or derived. Leads from it are labelled LinkedIn-sourced, stay in the review lane (`login_required`), and are never emailed automatically.

## Licensing feasibility
Unknown until the question above is answered. The plausible routes are (a) an approved LinkedIn partner API the tenant or dazl is licensed for, or (b) data the tenant itself exports or supplies. Route (a) needs LinkedIn's approval and terms review (cost, field limits, retention, whether lead generation is a permitted use); route (b) gives only the tenant's own data. Until one is confirmed in writing, there is no licensed source and the code must not be activated.

## How a transport call maps to upstream requests
One `LinkedInTransport.fetch` call = one upstream request = one page of at most 25 items. A transport must not paginate, retry or fan out inside a call; a result that reports `upstream_requests` other than 1 is discarded and stops the run with a cooldown. The platform-wide budget is **3 upstream requests per tenant per hour across every LinkedIn consumer** (the people reader and the existing advanced post search share one atomic budget), at most 2 per scan from the people reader.

## Gates (all re-checked before every request)
`ADVANCED_CONNECTORS=1`, `ADVANCED_KILL` not `1`, `ADVANCED_LINKEDIN=1`, `ADVANCED_LINKEDIN_PEOPLE=1`, the tenant's LinkedIn consent, and the tenant's own `adv:linkedin` connector switch not disabled. A hard 20 s deadline per call; a result that arrives after it is discarded even if the transport ignored the abort. Throttled / challenge / unauthorised answers stop the run and start a 24 h cooldown for that tenant.

## Open source / transport feasibility gaps (none closed in this change)
1. **No verified official source.** I know of no self-serve official LinkedIn API for people search or competitor-post engagement lists; both would need LinkedIn's approval and terms review. Until that is confirmed in writing, there is nothing to build a transport on.
2. **The 3/hour and 2/scan limits are dazl's own caps, not derived from any LinkedIn quota.** An official API will have its own limits (and may paginate with cursors and charge per call); the cap and the single-page rule must be re-derived from the actual terms. One page of at most 25 items per request bounds yield per request.
3. **Credentials.** A partner/OAuth integration would introduce a credential (client secret, access token). Storing and rotating it per tenant (encryption, isolation, revocation) is not designed here and needs its own review. Today no credential is read or stored.
4. **Third-party personal data.** Engagers are individuals who did not ask to be prospected. A lawful basis, notice, retention and deletion path (and whether lead generation is a permitted use of the licensed data) must be settled before activation. Leads are kept in the review lane and never emailed automatically, but that does not settle the legal basis.
5. **What a transport must prove.** `web/lib/signals/linkedin-transport-contract.ts` is the conformance check any transport is held to before it can be injected: one call = exactly one upstream request (no pagination, retry or fan-out), at most 25 items, only `url/title/quote/date`, public-profile URLs only, honours the abort. `mapUpstreamStatus` fixes the mapping: 2xx ok; 429/503 throttled; 401/403 unauthorized; 999/451 challenge; anything else an error. A transport that fails the check, or reports a different upstream count than it made, must not be injected.
6. **Freshness and evidence.** A profile is login-walled evidence dazl cannot re-read, so no lead from this source can be verified by dazl's page verifier; it can only be a review-lane lead.

Accounting note: the shared hourly budget counts reservations and also the connector's recent audit rows (the larger of the two), so calls recorded before reservations existed still count.
