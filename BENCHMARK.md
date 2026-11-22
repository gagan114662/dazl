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
| Ahead of Gojiberry and Pancake on the same prompts | yes | not run yet |

## Runs

| Date | Commit | What changed | Prompts at 5+ ready | Ready (total) | Leads listed | Named % | Dated % | Cost (US$) |
|---|---|---|---|---|---|---|---|---|
| 2026-11-22 | `751eb629` (main) | Baseline: the product as it is, default scan path, on staging. [table](bench/results/2026-11-22-751eb629-baseline.txt) | 0 of 16 | 0 | 84 | 40 | 17 | 1.10 |

## Head-to-head

| Tool | Prompts run | Leads shown | % named | % with dated proof | Notes |
|---|---|---|---|---|---|
| dazl (baseline) | 16 | 0 | n/a | n/a | 84 leads found, every one held; 2 prompts failed outright |
| Gojiberry | pending | | | | |
| Pancake | pending | | | | |

## What the baseline shows

The product found 84 leads across 16 prompts and showed none of them. Every lead was held, almost all for one of two reasons: "needs your review" or "event timing unknown". Finding is not the main problem; hiding is.

Two prompts failed outright with `unbounded_fallback_hold` (hospitals in Bengaluru, people engaging with a competitor's posts).
