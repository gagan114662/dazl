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
- **Cost is what the run incurred.** Every attempted task (complete, incomplete, failed, and any unsupported or not-run task that reports a cost) counts toward the run total and cost per validated company. **Unknown cost** stays unknown and is never $0: one attempted task without a cost makes the run total unknown. A complete-tasks-only figure is shown separately, labelled as not the run's cost, and no threshold uses it.
- **Negative tasks must run.** A false-alerts result exists only when every negative task in the set completed; a negative task that was not run, failed or stopped is insufficient sample, never "0 false alerts".
- **Breakdowns** by region and sector, false alerts on negative tasks, unique validated companies across tasks, and median time.
- **Recorded with every run:** system and version, commit, configuration (model, rubric, sources, budget) and the evaluator.
- **Input integrity: every recorded attempt is accounted for exactly once, or nothing is scored.** A run has one record per task (its status, cost and results). The scorecard trusts nothing about its input: the frozen task set, the recorded attempts and their results must agree, or the whole report is `invalid_input`, listing every problem with its code, task id and reason. No totals, no lower cost, no threshold result (every threshold reads `invalid_input`, never `meets` or `misses`), no card file, exit code 2. Nothing is selected, merged or dropped on the way: a repeated attempt is not "the last one wins", an unknown task is not skipped. Rejected, among others:
  - a task id recorded twice (for example a failed $100 attempt and a complete $1 attempt on the same task), or a frozen task listed twice in the set;
  - an attempt for a task that is not in the frozen set, or a run whose `task_set_version` is not the set's;
  - a cost or results recorded without an outcome (no or unknown `status`), or results on a task whose status is `not_run` or `unsupported`;
  - a negative, non-numeric or non-finite cost or time (unknown is `null`, never a string or a negative number);
  - a result with a verdict outside pass / fail / unknown / contradicted, a missing field verdict, no entity, a duplicate or non-positive rank, or a gap in the ranks (they must be exactly 1..n: a missing rank is a result dropped from the evidence);
  - a `system` or `commit` that is not a plain name (letters, digits, `.`, `_`, `-`): they name the card file;
  - a file that is truncated or not JSON, a run that is not `dazl-benchmark-run` version 1, no frozen task set for the run's version, an aggregate that is not numeric.

  The same boundary applies to `from-scoreboard` (a scoreboard row outside the set, or recorded twice, converts to nothing) and to `compare` (a file that is not a scored card is rejected). Statuses, verdicts, ids and versions are exact: `Complete`, `passed`, ` a` or `v1` are rejected, never read as something close. A threshold file with no list is `invalid_input` as a whole; an entry that names a metric the card does not have, an op other than `>=`, `<=`, `==`, a non-numeric value or sample size, or a sample other than `negative`, is `invalid_input` for that threshold.

A run can be evaluated against release thresholds only when **all** of these hold:
- its origin is live or recorded (not synthetic, not a historical aggregate);
- its evaluator is **independent** of the system that produced the results.

`from-scoreboard` converts a recorded `scripts/scoreboard.mts` result into a run whose verdicts come from the pipeline's own fields. That is a **self-report**: it is shown, but it can never meet a threshold.

**Exit codes:** 0 ok; 1 a regression (`compare`); 2 usage or `invalid_input`.

**`compare`** exits 1 when a metric got worse between two scorecards of the same task set: lower precision@10, more validated or unique companies lost, more false alerts or contradictions, a higher unknown rate, or a task that stopped completing. That is the release regression gate once real runs exist.

```bash
cd web
node --experimental-strip-types scripts/benchmark.mts history
node --experimental-strip-types scripts/benchmark.mts from-scoreboard --result ../scoreboard/results/<date>-<commit>.json --out /tmp/run.json
node --experimental-strip-types scripts/benchmark.mts scorecard --run /tmp/run.json --thresholds --out /tmp/cards
node --experimental-strip-types scripts/benchmark.mts compare --before /tmp/cards/A.json --after /tmp/cards/B.json
```

## The batch runner (`web/lib/benchmark/runner.ts`, #397)

`node --experimental-strip-types scripts/benchmark.mts run --batch BATCH.json [--store STORE.json] [--out DIR]` runs one
blinded, equal-budget batch. It produces each system's benchmark run, scores each one with the scorecard above (it is not
a second scoreboard), and writes one batch report with, per system:
- precision@5 and precision@10;
- unique actionable yield: validated companies no other system in the batch validated;
- coverage: complete tasks out of all tasks;
- elapsed seconds, spend and operator interventions.

**Same task for every system:**
- Briefs are frozen (deep-frozen and hashed) before the first run.
- Every system gets the identical brief, the same as-of day and window, and the same per-task cost and time limits.
- The order rotates per task, seeded, so every system goes first equally often.

**Idempotent:** every (batch, system, task) has a stable run id. With `--store`, a re-run reuses what is recorded and
calls nothing again. A change to the briefs, systems, budget or seed is a different batch.

**Honest gaps:**

| situation | recorded as |
| --- | --- |
| no authorized adapter (e.g. no Pancake or Gojiberry account) | `unsupported`, with the reason; the system is **not ranked**, never a zero-result loser |
| budget, timeout or rate-limit stop | `incomplete` |
| login wall, paywall or missing feature | `unsupported`; it is never bypassed |
| adapter error | `failed` |

None of these is an empty market.

**Durable budget:** the batch total is reserved before each task. A task with an unknown cost reserves its full limit. Once
the total would be exceeded, the remaining tasks are `not_run`. A paid live adapter needs explicit authorization and a
preset finite budget, or it does not run.

**Blind scoring:** outputs are canonicalised (one row per company, by domain, else by normalised name; the raw output is
kept beside it). They are then pooled per task across systems, given opaque ids, shuffled, and judged without the system,
product, model or configuration. Any system id, product or model name in an item's text or contact is replaced with
`[system]`, and an evidence URL that names one is withheld, so an output cannot sign itself (the count is in the
manifest's `blinding`). An evaluator failure, or an item it leaves out, is `unknown`. Every judgement is recorded in the
batch's `evaluations` (blind id, system after unblinding, task, entity, verdicts and the evaluator's own record).

**Equal limits are enforced:** a run over the task's time limit (by the clock, or by its own report) or its cost limit is
`incomplete`, not complete.

**Frozen task set:** a recorded or live batch must run the committed task set for its version
(`scoreboard/benchmark/v<version>/tasks.json`) unchanged, or it does not run; the CLI looks it up by version and exits 2
(`invalid_input`) on any difference. A synthetic batch with no committed set for its version may run, labelled synthetic.

**Scoring hook to the #394 contract:** `contractEvaluator()` wraps a per-lead contract scorer (`evaluateLead` from
`lib/evals/contract.ts`, PR #571) as the blind evaluator. Per task it takes the frozen contract (none: every item is
`unknown`, never inferred) and maps each blind item to lead evidence. The contract's field verdicts map onto the
scorecard fields, worst first (contradicted, fail, unknown, pass):

| scorecard field | contract fields |
| --- | --- |
| identity | `identity.entity`, `source.on_page` |
| constraints | `place.matches`, `industry.matches`, `event.predicate`, `consent.status` |
| event_date | `event.date_real`, `event.date_in_window` |
| contact | `contact.usable` |

A field the contract did not score is `unknown`. The tier, status, scorer and field rationales go into the judgement
record. The hook is typed by shape; it is exercised with a stub scorer until #571 lands.

With `--store`, each run is written to the store as soon as it is recorded, so an interrupted batch resumes where it
stopped.

**Origin is never upgraded:** a batch is all synthetic, all recorded or all live, and mixing is refused, so a synthetic
fixture can never sit beside, or be presented as, a product's live result. The scorecard refuses to evaluate thresholds on
synthetic data.

`web/test/fixtures/benchmark/synthetic-batch.json` is a SYNTHETIC batch: four invented tasks, `dazl` and a plain-chat
baseline as hand-written outputs, and Pancake and Gojiberry unavailable. It exercises the runner and is no result of any
product.

**Not built:** live adapters (a dazl adapter over `runJob`, and the competitor ones), and no live or paid batch has run.
Each needs owner-authorized accounts, keys and a budget. Repeated runs with uncertainty are #398.

## Repeated-run superiority (`web/lib/benchmark/superiority.ts`, #398)

`benchmark.mts superiority --plan PLAN.json --hash HASH --ledger LOOKS.json --batches A.json,B.json,...` compares a candidate
with a baseline over repeated batches from the runner. It returns `win`, `loss` or `inconclusive` for each metric, overall
and per segment (region, sector). Each answer comes with its interval and its pair and cluster counts.

**Preregistered.** The plan is frozen and hashed before any result is viewed. It fixes:
- the metrics and their direction, and each one's minimum effect;
- the precision floor (proposed 0.90) and the yield advantage (proposed ×1.25, i.e. +25%);
- the cost ceiling and the critical floors;
- the minimum pairs and clusters, the cluster unit, the bootstrap, the stop rule, and a stated power rationale.

The analysis refuses a plan whose hash differs from the registered one. A look ledger counts analyses, and the stop rule
refuses past `max_looks`, so results are not re-examined until they look like a win. All the values are configuration, not
code.

**Inputs are checked whole.** A plan, ledger or batch file with a wrong type, a missing or unknown key, an out-of-range
value (for example more than 20,000 bootstrap resamples or 20 looks), a replayed batch, or a scorecard task with no run
is refused with every problem named (exit 2). A refused call never counts a look. The first look needs `--new-ledger`.
A missing ledger is never silently treated as a fresh one, and an existing one is never reset. The look is written to the
ledger before the result is printed. `cluster_by` brief or account needs `--clusters MAP.json`; it never falls back to
one cluster per task. Commit the plan and its ledger together (`scoreboard/benchmark/prereg/<plan id>/`): the tool
cannot stop someone deleting a ledger file, but git history shows every look.

**Paired and clustered:**
- One pair is a (task, repetition) where both systems completed the task.
- A task one side did not complete is listed as a missing pair, never scored as zero. The failure rate itself is measured.
- `coverage` (1 when the system completed the task, else 0) and `failure_rate` are paired over every task both systems
  were given, overall and per segment. A market one side never completed is still reported, never dropped.
- Intervals are a cluster bootstrap over tasks (or briefs or accounts), so ten repetitions of one task are one cluster,
  not ten pieces of evidence.

**Decisions:**
- Too few pairs or clusters, or an interval that reaches inside the minimum effect, is `inconclusive`. The interval decides,
  never the average.
- There is **no overall winner** when a critical floor fails: contradicted results, false alerts, precision@10 under the
  floor, or cost per validated over the ceiling. That holds whatever the other metrics say.
- Overall `win` needs every primary metric to win, every floor to hold and the registered yield advantage to be shown.

**Evidence kept apart:** this measures evaluator-validated performance only. Customer outcomes come from an opted-in
pilot (#399) and are reported as not measured here. Batches of different origins, or with different frozen briefs, are
never pooled, and synthetic batches are labelled as saying nothing about any product.

**Monitoring** (`monitoring(snapshots)`) covers repeated runs of one monitor:
- net-new validated events per day;
- the duplicate rate;
- freshness: the median age of a new event when it first appears;
- correction retention: a corrected event that comes back as new counts against it.

A span under 14 days is reported as `adequate: false`, never stretched.

## The published scorecard page (`/app/scorecard`, #398)

A signed-in read-only page. It is rendered on the server from committed artifacts (`web/lib/benchmark/published/`): no fetch, no model call.
- **Nothing is claimed until a live or recorded batch is published.** Until then the headline says no comparison has been run, and the only batch shown is
  `example-synthetic.json`, under its own SYNTHETIC / invented-data label. A synthetic batch in the published slot is ignored.
- **A system that did not run** (for example no authorized Pancake or Gojiberry account) shows its reason, no numbers and no rank, and is "not counted as a loss".
- **Unknown stays unknown:** a missing cost reads `unknown`, a missing precision `n/a`, never 0.
- **A win is stated only when the repeated-run analysis says `win`.** One batch shows no win, loss or interval. A failed critical floor reads "No winner".
- **Evaluator-validated performance only.** Customer outcomes (#399) are not measured here.

`node --experimental-strip-types scripts/publish-scorecard.mts --batch batch-XXXX.json [--superiority sup.json]` writes `latest.json`. It refuses a synthetic batch,
an evaluator that is not independent, a synthetic analysis, and an analysis that does not include the batch.

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
| no-false-alerts | 0 validated results on negative tasks | 10 complete tasks and every negative task complete |
| no-contradicted | 0 contradicted results (no wrong company or contact) | 10 complete tasks |
| unknown-rate | unknown rate ≤ 25% | 10 complete tasks |
| coverage | ≥ 12 of 14 tasks complete within budget | none |
| unique-yield | ≥ 20 distinct validated companies (placeholder; the real target comes from competitors on the same tasks) | 10 complete tasks |
| cost-per-validated | ≤ $2 per validated company, all attempts' cost included (unknown cost cannot meet it) | 10 complete tasks |

The report always reads *"thresholds are proposed: owner approval required; nothing is accepted by this report"*. A threshold result is `meets`, `misses`, `insufficient_sample`, `not_evaluable` or `invalid_input` (the run failed the integrity check above; nothing was evaluated).

## What it takes to produce real numbers (not done; each needs authority)

1. **An independent evaluator** for the four fields (#394 contract, #395/#396). Until then every dazl run is a self-report.
2. **An owner-authorized dazl run:** the scoreboard key and TinyFish key, and a total budget. The scoreboard's own spend guard covers the six reused tasks; the other eight need the same harness pointed at v1.
3. **Competitor and baseline runs** on the same tasks: Pancake, Gojiberry, and a specified plain-ChatGPT web-research baseline. This needs accounts and paid plans, so it is owner decisions. A system that cannot express a task is recorded `unsupported`.
4. **Repeated runs and paired comparison** with uncertainty (#397/#398), and the week-long recurring-discovery measurement from #393.
5. **Customer outcomes** (qualified conversations, meetings, cost per usable opportunity) stay separate from benchmark validation. They need an opted-in pilot (#399), never unsolicited benchmark sends.
