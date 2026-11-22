# dazl benchmark

The one measure of progress: how many good leads a real request returns. Updated after every run.

- Prompts: [`bench/prompts.json`](bench/prompts.json) (16: 12 open web, 4 LinkedIn)
- How to run: [`bench/README.md`](bench/README.md)
- Run tables: [`bench/results/`](bench/results/) (counts only; no lead or contact data, the repo is public)

## Launch bar

| Measure | Bar | Latest |
|---|---|---|
| Prompts with at least 5 ready leads | 13 of 16 | 0 of 16 (baseline) |
| Shown leads with a named person | 70% | no leads shown (40% of the 84 listed) |
| Shown leads with a dated proof link | 100% | no leads shown (17% of the 84 listed) |
| Cost per prompt | under US$1 | US$0.07 average (baseline) |
| Owner hand-check of 20 random leads | 16 real | not done |
| Ahead of Gojiberry on the same prompts | yes | behind: 0 of 16 against Gojiberry's 10 of 16 |

## Runs

| Date | Commit | What changed | Prompts at 5+ ready | Ready (total) | Leads listed | Named % | Dated % | Cost (US$) |
|---|---|---|---|---|---|---|---|---|
| 2026-11-22 | `751eb629` (main) | Baseline: the product as it is, default scan path, on staging. [table](bench/results/2026-11-22-751eb629-baseline.txt) | 0 of 16 | 0 | 84 | 40 | 17 | 1.10 |

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

### Per prompt

| Prompt | Gojiberry leads | With dated proof | dazl baseline shown |
|---|---|---|---|
| toronto-dental-expanding | 4 | 0 | 0 |
| austin-saas-sales-hiring | 10 | 0 | 0 |
| pune-roofing-expanding | 0 | 0 | 0 |
| dubai-law-new-partner | 5 | 4 | 0 |
| london-fintech-funding | 111 (25 checked) | 0 | 0 |
| us-seed-first-sales | 1 | 0 | 0 |
| ohio-payroll-hiring | 3 | 2 | 0 |
| sydney-logistics-new-leader | 4 | 4 | 0 |
| berlin-ecommerce-marketing-hiring | 11 (4 companies) | 0 | 0 |
| bengaluru-hospitals-new-branch | 18 (about 10 organisations) | 7 | 0 |
| illinois-manufacturing-new-plant | 14 (6 companies) | 1 | 0 |
| singapore-restaurants-new-outlets | 7 | 4 | 0 |
| linkedin-competitor-post-engagers | 2 | 0 | 0 |
| linkedin-new-heads-of-sales | 545 (25 checked) | 0 | 0 |
| linkedin-first-marketer-hiring-posts | 6 (3 companies) | 0 | 0 |
| linkedin-crm-evaluating-posts | 8 | 0 | 0 |

## What the baseline shows

The product found 84 leads across 16 prompts and showed none of them. Every lead was held, almost all for one of two reasons: "needs your review" or "event timing unknown". Finding is not the main problem; hiding is.

Two prompts failed outright with `unbounded_fallback_hold` (hospitals in Bengaluru, people engaging with a competitor's posts).
