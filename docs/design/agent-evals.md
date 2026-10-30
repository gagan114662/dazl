# Agent evals: traces, Worlds, cases, evaluators, runs

Status: increment 1 is implemented (pure code: `web/lib/evals/`; replay harness and suite: `web/test/helpers/eval-replay.ts`,
`eval-suite.ts`, kept out of lib/ because they open a raw in-memory SQLite handle; tests: `web/test/evals.test.ts`; gate: `web/scripts/evals.mts`).
It covers ONE path, scan/discovery, with ONE case built from a SYNTHETIC trace. No recorded production trace has been
captured or stored, no real run has been replayed, and nothing here is a measurement of live lead quality. Part of #394.

## Why

A scan, an enrichment, a draft, a reply classification and an autopilot decision each depend on data outside dazl
(search results, pages, provider answers, inbox messages). Today a behaviour change is judged by hand or by a live run that
cannot be repeated. This turns real (redacted) or synthetic tasks into repeatable, scored tests: the same frozen input,
replayed through the real agent code, scored by deterministic verifiers, and compared between two agent versions.

It extends, and does not compete with, the lead-quality benchmark (#372, owned by the ops builder) and the scoreboard
(`web/lib/scan/scoreboard.ts`). Split of responsibility:

| | #372 benchmark / scoreboard | agent evals (this) |
| --- | --- | --- |
| question | how good are dazl's leads on realistic live requests, against competitors | did this code change make the agent better or worse on known tasks |
| data | live (or recorded) benchmark runs | frozen Worlds: synthetic, or redacted recordings |
| output | release scorecard, thresholds, competitor comparison | per-case verdicts + a baseline gate in CI |
| shared | the evaluation contract (#394): verdict states, unknown-is-never-pass, versioned scorers. The evaluators here are written so #372's runner can call them on its own canonicalised leads. |

## The pipeline

```
real run ──record──▶ Trace ──redact──▶ Trace(redacted) ──freeze──▶ World ─┐
hand-written ─────────────▶ Trace(synthetic) ─────────────freeze──▶ World ─┤
                                                                            ▼
                         Case = World + input + expected outcomes ──replay(real runJob, stubs from World)──▶ ReplayResult (+ its own Trace)
                                                                            │
                                                     deterministic evaluators ─▶ verdicts ─▶ CaseScore ─▶ baseline gate (CI)
```

### 1. Trace (`lib/evals/trace.ts`)

One run = ordered spans, one per external call, recorded by wrapping the seams `runJob` already takes (`RunDeps`). Nothing
inside the agent changes; a wrapper returns and throws exactly what the inner call did.

```ts
Trace { v: 1, kind: 'dazl.trace', id, path: 'scan.discovery',
        synthetic: boolean, redacted: boolean, started_at, agent: { commit, label? },
        input: { request, icp, as_of }, spans: Span[], output?: { status, leads[] },
        synthetic_defaults?: { http? } }        // hand-written traces only
Span  { id, seq, kind: 'model'|'http'|'page'|'source_http', name, start_ms, duration_ms,
        input, output, error?, cost_usd? }      // cost: from reported usage x listed price; null = unknown, never 0
```

| seam (`RunDeps`) | wrapper | span |
| --- | --- | --- |
| `providers` | `TraceRecorder.providers` | `model`: stage (from the prompt template's opening), method, prompt, max_tokens, reply, served model, usage, cost |
| `fetchImpl` (and global `fetch` during replay) | `TraceRecorder.fetch` | `http` `tinyfish.search` / `tinyfish.fetch` / `http`: method, URL, body, status, response body |
| `fetchPage` | `TraceRecorder.pageFetcher` | `page`: URL, the Page or FetchFail |
| `sourceHttp` | `TraceRecorder.safeGet` | `source_http`: URL, HttpResult |

Never recorded: the provider's API key argument, request headers (TinyFish's key is a header). Prompts, pages and replies
ARE recorded, so a trace of a real run is PII until redacted. `totals(trace)` gives model calls, HTTP calls, page fetches,
errors, cost (with `cost_complete` when every call was priced) and wall time.

Production capture is built and **OFF by default**; see "Production capture" below.

### 2. World (`lib/evals/world.ts`)

A frozen snapshot of everything outside dazl that one run saw. Data only: no expected outcome, no credential.

```ts
World { v: 1, kind: 'dazl.world', id, origin: 'synthetic'|'recorded', redacted, as_of, from_trace?,
        search: { by_query: { [query]: Hit[] | { status } }, default?: Hit[] },   // default: synthetic only
        tinyfish_pages: { [url]: { title, text } },
        pages: { [url]: Page | { fail } | { unreachable: true } | { threw } },   // the verifier's own fetch
        http: { [url]: HttpResult | null }, http_default?: HttpResult,          // every other HTTP; default: synthetic only
        model: { [stage]: Reply[] } }                                           // consumed in order per stage
```

- `worldFromTrace(trace)` freezes spans into a World. It refuses a real trace that was not redacted, and a real trace
  carrying synthetic defaults. Errors are kept as errors (a fetch that threw replays as a throw).
- Model replies are keyed by stage (`replayStage`: the extraction template's opening, else model-usage's stage table), not
  by prompt hash. A prompt-wording change in a PR still finds its reply, so two agent versions can be compared on the same
  World; a version that makes an extra call of a stage meets a world miss (below), which is reported, not hidden.
- A recorded World answers ONLY what was recorded: no `search.default`, no `http_default`, no implicit empty people search.
- `as_of` is the instant the snapshot was taken; the replay freezes the process clock there so date windows are judged as
  the run saw them.

### 3. Case (`lib/evals/case.ts`)

```ts
Case { v: 1, kind: 'dazl.case', id, title, path: 'scan.discovery',
       world: '<path relative to the case file>',
       provenance: { from_trace, synthetic, why },
       input: { request, icp, score?, ground? },
       expect: { leads: [{ company, outcome: 'verified'|'held'|'absent', review_reason?, why? }],
                 exhaustive?, entities?: { [company]: { domains[] } }, window_days? } }
```

Expectations name outcomes, never mechanism, so the same case scores two versions. Ground truth the agent must not see
(which domains belong to a company) lives in the case, never in the World. "Turn a trace into a case" = freeze the trace's
World, copy its input, write the expected outcomes (for a failed production task: what SHOULD have happened).

### 4. Evaluators (`lib/evals/evaluators.ts`)

```ts
Evaluator { id, version, kind: 'deterministic'|'judge', critical, evaluate(ctx: { kase, world, result }): Verdict[] }
Verdict   { evaluator, version, subject: 'run' | 'lead:<company>' | 'expect:<company>', status: 'pass'|'fail'|'unknown', rationale, evidence? }
```

Rules (#394): unknown is never pass. A case passes only when every verdict passes; any fail makes it fail, otherwise any
unknown makes it unknown. `validated_rate` counts unknowns in the denominator and `unknown_rate` is reported separately.
Evaluators read the case, the World and the result; they cannot change the input or the targeting.

Scan evaluators in increment 1 (all deterministic, contract `dazl.evals/1`):

| id | subject | fails when | unknown when |
| --- | --- | --- | --- |
| `world_closed` | run | the replay asked for anything the World could not answer | - |
| `event_date_in_window` | each verified lead | date not a real calendar day, after as_of, or outside the window | no date |
| `evidence_in_world` | each verified lead | quote not on the World's copy of the cited page, page not in the World, no quote | - |
| `place_on_page` | each verified lead | - | the cited page never names a requested city (no gazetteer: "another city" and "no place" are both unknown) |
| `contact_domain_matches_company` | each verified lead with a contact | email domain is not one of the company's (case ground truth) | phone-only contact, or no ground truth |
| `no_tenant_leak` | run | a canary value from the second tenant appears in any outgoing span input or lead, a lead belongs to it, or its rows changed | - |
| `expected_outcomes` | each expectation | outcome or hold reason differs; exhaustive case verifies an unnamed company | - |

These evaluators deliberately do not reuse the scan's own checks (`place_on_page` is a plain look for the city, not
`placeAgreement`): the pipeline must not be its own sole judge (#395).

LLM judges come only where no deterministic check exists (buyer need, semantic claim support), with their own model
configuration and budget, and only after their agreement with labelled synthetic fixtures is measured (#396). None exist yet.

### 5. Replay harness (`test/helpers/eval-replay.ts`, result shape `lib/evals/result.ts`)

`replayCase(case, world)` runs the REAL `runJob` with every seam answered from the World, through the recorder:

- model: a provider whose `research`/`complete`/`completeDetailed` return the next reply for the prompt's stage;
- `fetchImpl` and global `fetch`: TinyFish search by exact query, TinyFish fetch by URL, everything else by `world.http`;
- `fetchPage`: `world.pages`; `sourceHttp`: `world.http`.

Anything unanswered is a **world miss**: recorded and answered as a failure (no results, a fetch error, a model error),
never sent anywhere. This builds on the two existing fences rather than replacing them:

- `web/test/helpers/net-fence.ts` (loaded by `npm test` and the eval CLI): scrubs credentials from the env and throws on
  any non-loopback connect, so a seam the World does not cover fails loudly instead of reaching the network. Its documented
  limits (DNS, direct undici, child processes) apply here too.
- the staging/stub conventions (`lib/staging.ts`, `test/helpers/acceptance-harness.ts`): the harness's stubs are the
  shape this generalises - same seams, same in-memory migrations - but driven by a versioned World file instead of an
  inline fixture, recording what it answers. One difference found on the way: the acceptance harness answers every
  unknown fetch with `200 {}`; the scan actually reaches ATS boards, SEC filings and news feeds through global `fetch`,
  so a World lists those (a synthetic one may use `http_default`) and a replay reports any it missed.

Isolation per replay: a fresh in-memory database, a throwaway master key, a stub API key, a second tenant seeded with
canary rows, autopilot replaced by a counter (a scan replay never drafts or sends), sitecrawl and news off (not in World
v1), clock frozen at `as_of`, env and global `fetch` restored afterwards.

### 6. Runs and the gate (`test/helpers/eval-suite.ts`, `scripts/evals.mts`)

`runSuite` replays every case under `web/test/fixtures/evals/cases`, scores it, and `gate` checks the result against
`web/test/fixtures/evals/baseline.json`, which is the suite's REGISTRY: every case is listed (passing ones with
`non_pass: []`) with its known non-pass verdicts, plus `min_cases`. The gate is red when:

- a case's non-pass verdicts differ from its list in either direction (a new one is a regression; a listed one that no
  longer happens must be removed in the PR that fixed it);
- a registered case did not run (its file was deleted, renamed, or no longer ends in `.case.json`);
- a case ran that is not registered, or two case files share an id;
- fewer than `min_cases` cases ran, or none did.

So removing a case takes three visible edits (the file, its registry entry, the floor), and none of them alone leaves
the gate green. A case or World file that fails to load stops the run with a non-zero exit. `test/evals.test.ts`
asserts the committed suite passes the gate and runs the CLI on a copy with a case deleted (it must exit 1), so
`npm test` in web-ci is the gate.

```bash
cd web && npm run evals -- --json /tmp/evals.json
```

Main-vs-PR comparison (#397/#398) is the same command on two checkouts, diffing the JSON (scores, cost, model calls,
wall time per case). Repeated runs and uncertainty intervals belong to #398 and are not built here.

## Redaction (`lib/evals/redact.ts`)

Required before any real trace becomes a World. Consistent HMAC tokens across the whole trace (string values AND object
keys), so a quote or contact that matched the page still matches: email local parts, phone digits (format kept; ISO dates
and date-times are not phones), LinkedIn `/in/` slugs, and every person name the run itself extracted. Tokens avoid
punctuation the verifier normalises away.

`redacted: true` means this pass ran. It is NOT permission to publish and NOT proof of complete anonymisation. Known gaps:

- email and web **domains are kept** (contact-domain checks need them); a domain can identify a small company or a person;
- a person named **only in page text**, never extracted as a lead or contact name, is not found;
- free-text identifiers the patterns do not know (street addresses, account numbers, handles other than LinkedIn) are kept.

**Recorded Worlds are private and unpublished**: tenant-scoped, never committed to this repository, never shared across
tenants. None has been captured or stored yet; every World in `web/test/fixtures/evals/` is synthetic.

## Production capture (`lib/evals/capture.ts`)

**Storage and retention are Gagan's decision.** What follows are the defaults until he says otherwise.

Capture is switched on and tuned by configuration, never code:

| setting | default | meaning |
| --- | --- | --- |
| `DAZL_TRACE_CAPTURE` | unset (OFF) | only `1` turns capture on |
| `DAZL_TRACE_RETENTION_DAYS` | `14` | whole days, 1-365. An invalid value never captures (nothing is kept with a retention nobody chose); the purge then uses 14 |

When on, `runJob` records the attempt with the same `TraceRecorder` the replay harness uses, through seams the run already
resolves: model providers and the verifier's page fetch via `deps.trace`, TinyFish search/fetch and every other
`fetchImpl` call. Off, `runJob` is exactly the untraced run: no wrapper, no `trace`, nothing stored. A seam whose
presence changes behaviour is never added (`newsHttp` turns news search on; `fetchPage` changes the resolution call).

On finish the trace is redacted (`redactTrace`, over every string of the trace including span errors and metadata:
secrets, emails, phones, profile slugs, extracted names), size-capped, and written. The cap is a hard bound on the exact
UTF-8 JSON bytes stored (2 MB): strings are cut to 50,000 characters, then span contents, then output leads, then input
and spans are dropped until it fits, and the insert refuses anything over it. `capture` records each drop with
`complete: false`, and `worldFromTrace` refuses an incomplete capture. A response body the recorder itself cut (its
body cap, a failed read, or the settle bound) counts as a drop (`bodies_truncated`), and `worldFromTrace` also refuses any
span marked `truncated`, whatever `capture` says. It is written to `scan_traces` in the app's own store: tenant-scoped, one row per attempt, PG
`0018_scan_traces.sql`. There is no third-party trace store. Reads (`listTraces`, `getTrace`) always take the tenant; another
tenant's trace id answers like an unknown one. Recording or storing never reaches the run: a failure is logged as
`{"trace_capture":"failed"}` with the error's class and code only (never its message, which can quote the row), and the scan's outcome stands. Response bodies are read from a clone in the
background (capped), so no caller waits on capture; a model provider's own API records no request or response body.
Storing happens after the run's own work and is bounded: body reads get 5 s (then what was read is kept, marked
`truncated`, and the stream is cancelled) and the whole finish 15 s, so a stalled stream or store can never keep `runJob`,
or the runner slot it holds, from returning.

Retention: each capture deletes its own tenant's rows older than the retention, and the scheduled tick
(`/api/internal/tick`, `purgeExpiredTraces`) deletes everyone's, whether capture is on or off. Shortening the retention
takes effect at the next purge. The tick still needs its external scheduler; activating that is not part of this change.

A stored trace is a recorded, redacted trace: `worldFromTrace` turns it into a private World that replays offline
(`test/trace-capture.test.ts` proves a capture replays to the same verdict with no world miss). Not recorded yet: the CSV
company path (`runCompanyJob`), adapter sources (`sourceHttp`) and the news search when a caller does not pass them, and
anything a module fetches without `fetchImpl`. A person named only in page text survives redaction (see "Redaction").

## The first case, and what it found

`scan-london-seed-traps` (SYNTHETIC; every company, page and address invented): a London seed-round request whose World
holds one genuine lead and the #395 traps - an old event on an undated page, a different-city company, a fabricated quote,
a future event. Replayed through the real scan:

| company | trap | agent | verdicts |
| --- | --- | --- | --- |
| Querix | none (genuine) | verified, contact kept | all pass |
| Northwind Analytics | quote names 2019 | held `event_date_stale` | pass |
| Brightpath AI | quote and company not on page | dropped | pass |
| Orbit Labs | event after as_of | held `event_date_future_date` | pass |
| Lumen Ledger | Paris company, London request | held `location_mismatch` (was **verified** before the fix) | pass (before the fix: `expected_outcomes` fail, `place_on_page` unknown) |

The Lumen Ledger result was a real agent gap: for a London request `placeAgreement` (`lib/scan/place-agreement.ts`) returned
`unconfirmed`, not `mismatch`, for a page naming a non-UK city (Paris, Berlin), and the runner holds only on `mismatch`. Fixed by
`otherPlace` (any city, any country; the requested city's name in another country), and the baseline entry was removed in the
same PR, so the case now passes outright.

## Next increments (one PR each)

1. ~~Production trace capture for scan/discovery~~ (built, OFF by default: "Production capture" above). Next: a classifier
   for stored traces that need attention (zero-yield scans, leads later rejected, verifier/judge disagreement) that queues
   them as case candidates.
2. Enrichment / contact finding: World entries for enrichment responses; verifiers for decision-maker title, former employee,
   generic recruiting inbox, contact-route provenance (#395).
3. Drafting and autopilot: inbox snapshot in the World; verifiers for no send without consent, opt-out and suppression respected,
   no claim absent from evidence.
4. Reply classification: inbox messages in the World; verifiers against labelled synthetic replies; disagreement flags.
5. LLM judges with calibration against labelled adversarial fixtures and drift checks (#396).
6. Two-version runs with repeated replays, paired comparisons and intervals (#397, #398); outcome pilots stay #399.
