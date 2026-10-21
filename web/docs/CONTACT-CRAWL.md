# Contact crawl (no key, no paid API)

After a scan finishes, dazl looks for business contacts published on each verified lead's own website.

Rules (hard):
- The company site is only taken from evidence we already hold: the cited page is on the company's domain, or links to a domain named like the company, or links to one with the company name as link text. Nothing is guessed. The homepage must name the company or the site is dropped.
- robots.txt is checked for every host, before any page (parsed with `robots-parser`). Unreachable or 5xx robots = no crawl. We obey the groups for `dazl-contact-check` and `dazl`, and Crawl-delay (cap 10 s). https only, same site only, one request per 2 s per host, at most 5 pages per site, 8 sites per scan.
- Only role mailboxes (info@, sales@, hello@, contact@ ...) on the company's own domain, plus tel: links. Named personal mailboxes and addresses at other domains are ignored. No pattern-built addresses. No login, no cookies.
- Each contact is stored in `lead_enrichments` (connector `sitecrawl`) with the exact page URL and the date retrieved. Each site crawled has a row in `connector_audit`.
- The draft flow (Outreach) uses a lead's cited-page contact first, then a stored sitecrawl email.

Config (env): `SITECRAWL_ENABLED=0` turns it off; `SITECRAWL_MAX_SITES` (8); `SITECRAWL_GAP_MS` (2000); `CRAWL4AI_URL` (optional sidecar, e.g. http://127.0.0.1:11235) to render JavaScript pages; `SITECRAWL_SOCIAL=1` enables the social-bio adapter. LinkedIn, Facebook, Instagram and X all disallow our user agent in robots.txt (checked live), so the adapter fetches nothing from them.

Crawl4AI (https://github.com/unclecode/crawl4ai) is Apache-2.0 with an attribution clause, see NOTICE. Libraries used in-process: `@crawlee/utils` (Apache-2.0, email extraction) and `robots-parser` (MIT).
