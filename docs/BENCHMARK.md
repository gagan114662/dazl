# Lead-quality benchmark and release scorecard (issue #372)

**What this is.** A versioned task set, a scorecard that keeps true denominators, the recorded evidence so far, and **proposed** release thresholds.

**What this is not.**
- It is not a measurement. No new run was made; no paid scan, competitor account or real-prospect contact was used.
- None of the thresholds is approved.
- No result here is evidence of live lead quality.

It follows the owner's direction on #372 (October 29): no routine human grading. Results are judged by the shared evaluation contract (#394) and by the independent evaluators being built under #394–#399. Work is split with agent evals (`docs/design/agent-evals.md`, #440):

| this benchmark (#372) | agent evals (#440) |
| --- | --- |
| how good dazl's leads are on realistic requests, against competitors and a plain-ChatGPT baseline | whether a code change made the agent better or worse on frozen cases |
| live or recorded runs; the release scorecard; thresholds | frozen Worlds; a baseline gate in CI |

Both use the same verdicts: pass, fail, unknown, contradicted, with unknown never counting as a pass.

## The task set (`scoreboard/benchmark/v1/tasks.json`)

The task set is frozen at 2026-10-29 and never edited in place: a change is a new `v2/`. It has 14 tasks across 10 countries:
- the **six scoreboard searches, unchanged** (Ohio, US seed-stage, Toronto, Lisbon, Pune, Gurugram);
- NYC local services with an exclusion (no dental service organizations);
- London SaaS (hire of a RevOps lead);
- Dubai B2B (product launch OR regional HQ);
- a German-language Munich manufacturing task (new facility);
- a Vancouver agency technology change (not hiring or funding);
- a **negative** task (Antarctica: any validated result is a false alert);
- an **ambiguous same-name** task (several US companies called Mercury);
- a **cold-start** task (Lagos supermarkets, including ones without a website).

Each task has the brief (seller), the request and structured hard constraints (`all_of`, `any_of`, `none_of`, geography, size, event and window).

## The scorecard (`web/lib/benchmark/scorecard.ts`, `npm`-free CLI `web/scripts/benchmark.mts`)

A run is one system on one task set. Each returned result has a verdict on **identity**, **constraints**, **event_date** and **contact**.
- **Validated:** all four fields pass. Unknown is never a pass.
- **Precision@5/@10** counts unknown results as not validated. The unknown rate and contradicted results are reported separately.
- **Incomplete, failed, unsupported and not-run tasks** are reported as such, never as zero. A competitor that cannot express a task is `unsupported`, with the reason.
- **Unknown cost** stays unknown; it is never $0. Cost per validated company is reported only when every complete task has a cost.
- **Breakdowns** by region and sector, false alerts on negative tasks, unique validated companies across tasks, and median time.
- **Recorded with every run:** system and version, commit, configuration (model, rubric, sources, budget) and the evaluator.

A run can be evaluated against release thresholds only when **all** of these hold:
- its origin is live or recorded (not synthetic, not a historical aggregate);
- its evaluator is **independent** of the system that produced the results.

`from-scoreboard` converts a recorded `scripts/scoreboard.mts` result into a run whose verdicts come from the pipeline's own fields. That is a **self-report**: it is shown, but it can never meet a threshold.

**`compare`** exits 1 when a metric got worse between two scorecards of the same task set: lower precision@10, more validated or unique companies lost, more false alerts or contradictions, a higher unknown rate, or a task that stopped completing. That is the release regression gate once real runs exist.

```bash
cd web
node --experimental-strip-types scripts/benchmark.mts history
node --experimental-strip-types scripts/benchmark.mts from-scoreboard --result ../scoreboard/results/<date>-<commit>.json --out /tmp/run.json
node --experimental-strip-types scripts/benchmark.mts scorecard --run /tmp/run.json --thresholds --out /tmp/cards
node --experimental-strip-types scripts/benchmark.mts compare --before /tmp/cards/A.json --after /tmp/cards/B.json
```

## Recorded evidence so far (`scoreboard/benchmark/history.json`)

| date | source | request | counts |
| --- | --- | --- | --- |
| 2026-10-25 | STATUS.md, Instinct live scan, 94e3c645 | Ohio | 2 hits, 1 candidate, 0 verified, 0 qualified reachable |
| 2026-10-26 | STATUS.md, isolated discovery+verifier, 21521e7 | Ohio | 78 hits, 3 candidates, 0 verified |
| 2026-10-26 | same | Lisbon | 53 hits, 3 candidates, 0 verified |
| 2026-10-29 | #352, owner live test | NYC dental | 2 found, 0 actionable (both undated) |
| 2026-10-29 | #352, owner live test | London | 2 found, 0 source-checked, 2 held |
| never | scripts/scoreboard.mts | the six scoreboard searches | not yet run with a real key; no result file exists |

None of these has per-result verdicts or an exact recorded query, so none is mapped to a v1 task, and none is release evidence. Taken as a whole they say: **no validated, reachable lead has been recorded yet.**

## Proposed release thresholds (`scoreboard/benchmark/proposed-thresholds.json`) — for the owner

All are proposals, built from #393's suggestions. Set the final values and sample sizes **before** looking at any result.

| id | proposal | minimum sample |
| --- | --- | --- |
| precision-at-10 | precision@10 ≥ 0.90 (unknown = not validated) | 10 complete tasks |
| no-false-alerts | 0 validated results on negative tasks | 10 complete tasks |
| no-contradicted | 0 contradicted results (no wrong company or contact) | 10 complete tasks |
| unknown-rate | unknown rate ≤ 25% | 10 complete tasks |
| coverage | ≥ 12 of 14 tasks complete within budget | none |
| unique-yield | ≥ 20 distinct validated companies (placeholder; the real target comes from competitors on the same tasks) | 10 complete tasks |
| cost-per-validated | ≤ $2 per validated company (unknown cost cannot meet it) | 10 complete tasks |

The report always reads *"thresholds are proposed: owner approval required; nothing is accepted by this report"*. A threshold result is `meets`, `misses`, `insufficient_sample` or `not_evaluable`.

## What it takes to produce real numbers (not done; each needs authority)

1. **An independent evaluator** for the four fields (#394 contract, #395/#396). Until then every dazl run is a self-report.
2. **An owner-authorized dazl run:** the scoreboard key and TinyFish key, and a total budget. The scoreboard's own spend guard covers the six reused tasks; the other eight need the same harness pointed at v1.
3. **Competitor and baseline runs** on the same tasks: Pancake, Gojiberry, and a specified plain-ChatGPT web-research baseline. This needs accounts and paid plans, so it is owner decisions. A system that cannot express a task is recorded `unsupported`.
4. **Repeated runs and paired comparison** with uncertainty (#397/#398), and the week-long recurring-discovery measurement from #393.
5. **Customer outcomes** (qualified conversations, meetings, cost per usable opportunity) stay separate from benchmark validation. They need an opted-in pilot (#399), never unsolicited benchmark sends.
