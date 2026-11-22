# dazl benchmark

The one measure of progress: how many good leads a real request returns. Updated after every run.

- Prompts: [`bench/prompts.json`](bench/prompts.json) (16: 12 open web, 4 LinkedIn)
- How to run: [`bench/README.md`](bench/README.md)
- Run tables: [`bench/results/`](bench/results/) (counts only; no lead or contact data, the repo is public)

## Launch bar

| Measure | Bar | Latest |
|---|---|---|
| Prompts with at least 5 leads shown | 13 of 16 | 10 of 16 (new engine); 0 of 16 (baseline) |
| Shown leads with a named person | 70% | 94% (66 of 70) |
| Shown leads with a dated proof link | 100% | 81% (57 of 70); 38 of those print the date on the proof page, 19 take the search index's page date |
| Cost per prompt | under US$1 | US$0.63 average; one prompt at US$1.02 (fixed since: a second pass now leaves room for the people pass) |
| Owner hand-check of 20 random leads | 16 real | not done |
| Ahead of Gojiberry on the same prompts | yes | level on prompts with 5+ leads (10 each); ahead on dated proof (57 leads against 22; 6 prompts with 5+ dated against 1) and on real full names; behind on speed and price |

## Runs

| Date | Commit | What changed | Prompts at 5+ ready | Ready (total) | Leads listed | Named % | Dated % | Cost (US$) |
|---|---|---|---|---|---|---|---|---|
| 2026-11-22 | `751eb629` (main) | Baseline: the product as it is, default scan path, on staging. [table](bench/results/2026-11-22-751eb629-baseline.txt) | 0 of 16 | 0 | 84 | 40 | 17 | 1.10 |
| 2026-11-22 | `456196c4` | New Claude discovery loop alone (`web/lib/discover`), 14 searches per prompt, on staging. "Ready" here is the loop's shown rule: the proof page names the company. [table](bench/results/2026-11-22-456196c4-discover-14-searches.txt) | 8 of 16 | 71 | 87 | 49 | 69 | 6.30 |
| 2026-11-22 | `c7761264` | Second search pass when fewer than 5 are shown; people, website and published-email pass on shown leads; undated pages take the search index's date; listing pages are not proof. [table](bench/results/2026-11-22-c7761264-discover-two-pass.txt) | 10 of 16 | 70 | 81 | 94 | 81 | 10.08 |

## The bar to beat: Gojiberry

Quest ran the same 16 prompts in Gojiberry on 2026-11-22 (issue #1568). Pancake was not run: its workspace is locked for a failed payment and the owner decided not to add spend, so Gojiberry is the head-to-head.

| Measure | Gojiberry | dazl baseline | dazl has to reach |
|---|---|---|---|
| Prompts with 5 or more leads shown | 10 of 16 | 0 of 16 | 11 of 16 or more (launch bar: 13) |
| Leads with a named person and title | about 97% (surnames are fake, see below) | none shown | 70% or more, with real full names |
| Leads with a dated signal and a proof link | 22 of about 120 checked (18%) | none shown | 100% of shown leads |
| Prompts where 5 or more leads have dated proof | 1 of 16 | 0 of 16 | 13 of 16 |
| Time to first lead | about 1 minute | 1.5 to 3 minutes | under 3 minutes |
| Cost per prompt | 0 credits (free search beta) | US$0.07 | under US$1 |
| Hand check of 10 leads | 7 real, 0 wrong, 3 could not be opened | not done | 16 of 20 real |

What Gojiberry does well: it is fast, free, and returns a named person with a title on almost every lead.

Where it is weak, which is where dazl can win:
- **Dates:** it almost never shows when the signal happened. Only 22 of about 120 leads had a date and a link.
- **Names:** contact surnames are masked with about 12 stand-in names. First name, title and company are real.
- **Repeatability:** the same prompt run twice returned different lists with 2 leads in common.
- **Filters ignored:** two prompts turned into directory filters with large counts (111 and 545) and no proof link; one ignored the funding stage, one ignored the 90-day window.
- **No results at all** for one prompt (roofing contractors in Pune).

### Per prompt: leads with a dated proof link

"Dated proof" means the lead is shown, carries the date of the signal, and links to the page that proves it.

| Prompt | Gojiberry leads | Gojiberry dated proof | New loop shown | New loop dated proof | dazl baseline shown |
|---|---|---|---|---|---|
| toronto-dental-expanding | 4 | 0 | 4 | 1 | 0 |
| austin-saas-sales-hiring | 10 | 0 | 4 | 3 | 0 |
| pune-roofing-expanding | 0 | 0 | 2 | 0 | 0 |
| dubai-law-new-partner | 5 | 4 | 7 | 5 | 0 |
| london-fintech-funding | 111 (25 checked) | 0 | 8 | 8 | 0 |
| us-seed-first-sales | 1 | 0 | 8 | 7 | 0 |
| ohio-payroll-hiring | 3 | 2 | 1 | 0 | 0 |
| sydney-logistics-new-leader | 4 | 4 | 2 | 1 | 0 |
| berlin-ecommerce-marketing-hiring | 11 (4 companies) | 0 | 1 | 0 | 0 |
| bengaluru-hospitals-new-branch | 18 (about 10 organisations) | 7 | 7 | 2 | 0 |
| illinois-manufacturing-new-plant | 14 (6 companies) | 1 | 6 | 6 | 0 |
| singapore-restaurants-new-outlets | 7 | 4 | 6 | 5 | 0 |
| linkedin-competitor-post-engagers | 2 | 0 | 0 | 0 | 0 |
| linkedin-new-heads-of-sales | 545 (25 checked) | 0 | 7 | 5 | 0 |
| linkedin-first-marketer-hiring-posts | 6 (3 companies) | 0 | 8 | 6 | 0 |
| linkedin-crm-evaluating-posts | 8 | 0 | 0 | 0 | 0 |
| **Total** | | **22** | **71** | **49** | **0** |
| **Prompts with 5 or more** | 10 | 1 | 8 | 7 | 0 |

Latest run (`c7761264`), per prompt:

| Prompt | Gojiberry leads | Gojiberry dated proof | dazl shown | dazl dated proof | dazl named |
|---|---|---|---|---|---|
| toronto-dental-expanding | 4 | 0 | 5 | 3 | 5 |
| austin-saas-sales-hiring | 10 | 0 | 6 | 3 | 6 |
| pune-roofing-expanding | 0 | 0 | 2 | 1 | 1 |
| dubai-law-new-partner | 5 | 4 | 7 | 7 | 7 |
| london-fintech-funding | 111 (25 checked) | 0 | 5 | 5 | 5 |
| us-seed-first-sales | 1 | 0 | 7 | 3 | 7 |
| ohio-payroll-hiring | 3 | 2 | 2 | 2 | 2 |
| sydney-logistics-new-leader | 4 | 4 | 5 | 5 | 5 |
| berlin-ecommerce-marketing-hiring | 11 (4 companies) | 0 | 3 | 2 | 3 |
| bengaluru-hospitals-new-branch | 18 (about 10 organisations) | 7 | 8 | 8 | 8 |
| illinois-manufacturing-new-plant | 14 (6 companies) | 1 | 7 | 7 | 7 |
| singapore-restaurants-new-outlets | 7 | 4 | 5 | 5 | 2 |
| linkedin-competitor-post-engagers | 2 | 0 | 0 | 0 | 0 |
| linkedin-new-heads-of-sales | 545 (25 checked) | 0 | 3 | 3 | 3 |
| linkedin-first-marketer-hiring-posts | 6 (3 companies) | 0 | 5 | 3 | 5 |
| linkedin-crm-evaluating-posts | 8 | 0 | 0 | 0 | 0 |
| **Total** | | **22** | **70** | **57** | **66** |

What it shows:
- 10 of 16 prompts return five or more shown leads, level with Gojiberry. The bar is 13.
- 57 shown leads carry a date and a proof link against Gojiberry's 22. 94% name a real person with a title; 96% have the company website; 39% have an email address a public page prints.
- Still short: Pune roofing, Ohio payroll and Berlin e-commerce (2 to 3 leads each), and the two prompts about LinkedIn posts, which need the customer's own LinkedIn through dazl Connect.
- Not measured yet: this is the discovery run on its own. The same prompts through the deployed app, and a hand check of 20 leads, are still to do.

### Free-trial budget (4 prompts, staging, 2026-11-22)

| Budget for one trial scan | Searches | Leads shown per prompt | Cost per prompt |
|---|---|---|---|
| US$0.30 (the current limit) | 5 | 0, 2, 4, 1 | US$0.08 to US$0.20 |
| US$0.75 (proposed, not approved) | 10 | 5, 8, 5, 1 | US$0.34 to US$0.46 |

## What the baseline shows

The product found 84 leads across 16 prompts and showed none of them. Every lead was held, almost all for one of two reasons: "needs your review" or "event timing unknown". Finding is not the main problem; hiding is.

Two prompts failed outright with `unbounded_fallback_hold` (hospitals in Bengaluru, people engaging with a competitor's posts).
