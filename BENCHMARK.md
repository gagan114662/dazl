# dazl benchmark

The one measure of progress: how many good leads a real request returns. Updated after every run.

- Prompts: [`bench/prompts.json`](bench/prompts.json) (16: 12 open web, 4 LinkedIn)
- How to run: [`bench/README.md`](bench/README.md)
- Run tables: [`bench/results/`](bench/results/) (counts only; no lead or contact data, the repo is public)

## Launch bar

| Measure | Bar | Latest |
|---|---|---|
| Prompts with at least 5 leads shown | 13 of 16 | 8 of 16 (new loop); 0 of 16 (baseline) |
| Shown leads with a named person | 70% | 49% (35 of 71) |
| Shown leads with a dated proof link | 100% | 69% (49 of 71) |
| Cost per prompt | under US$1 | US$0.39 average (new loop) |
| Owner hand-check of 20 random leads | 16 real | not done |
| Ahead of Gojiberry on the same prompts | yes | ahead on dated proof (7 prompts with 5+ dated leads against 1); behind on prompts with 5+ leads (8 against 10) and on named people |

## Runs

| Date | Commit | What changed | Prompts at 5+ ready | Ready (total) | Leads listed | Named % | Dated % | Cost (US$) |
|---|---|---|---|---|---|---|---|---|
| 2026-11-22 | `751eb629` (main) | Baseline: the product as it is, default scan path, on staging. [table](bench/results/2026-11-22-751eb629-baseline.txt) | 0 of 16 | 0 | 84 | 40 | 17 | 1.10 |
| 2026-11-22 | `456196c4` | New Claude discovery loop alone (`web/lib/discover`), 14 searches per prompt, on staging. "Ready" here is the loop's shown rule: the proof page names the company. [table](bench/results/2026-11-22-456196c4-discover-14-searches.txt) | 8 of 16 | 71 | 87 | 49 | 69 | 6.30 |

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

What the first full run of the new loop shows:
- It beats Gojiberry on dated proof on 9 prompts, ties on 4 (both zero) and loses on 3 (Ohio payroll, Sydney logistics, Bengaluru hospitals).
- It ran out of searches on every prompt. Claude said so each time. Cost averaged US$0.39, so there is room under the US$1 cap to search more.
- Named people are the weak column: 35 of 71. Gojiberry names someone on almost every lead.
- The two LinkedIn post prompts returned nothing, because LinkedIn posts cannot be read from the open web. They need the customer's own LinkedIn through dazl Connect.

## What the baseline shows

The product found 84 leads across 16 prompts and showed none of them. Every lead was held, almost all for one of two reasons: "needs your review" or "event timing unknown". Finding is not the main problem; hiding is.

Two prompts failed outright with `unbounded_fallback_hold` (hospitals in Bengaluru, people engaging with a competitor's posts).
