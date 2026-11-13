Two kinds of fixture, stated honestly (no Companies House API key was available when this was written, so the API responses were NOT recorded live):

- `pages.json`: REAL. The public company pages https://find-and-update.company-information.service.gov.uk/company/{16990000,17000000,17020000}, fetched 2026-11-10 (no robots.txt, HTTP 200, no key), converted with `htmlToText()` and trimmed from the company name to the first SIC line (what the scan page reader returns).
- `search-*.json`: SYNTHETIC in shape only. They follow the documented advanced-company-search envelope (`items`, `hits`, `kind`; row fields `company_name`, `company_number`, `company_status`, `company_type`, `date_of_creation`, `registered_office_address`, `sic_codes`) at https://developer-specs.company-information.service.gov.uk/companies-house-public-data-api/reference/search/advanced-company-search, but the values of each row are copied from the real public page above (name, number, status, type, incorporation date, address, SIC). A recording from a keyed call is the outstanding live proof (see the PR).

Tests that need a negative case build it inline from these rows and say so.
