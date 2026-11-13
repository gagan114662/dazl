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

Scan evaluators (all deterministic, contract `dazl.evals/1`):

| id | subject | fails when | unknown when |
| --- | --- | --- | --- |
| `world_closed` | run | the replay asked for anything the World could not answer | - |
| `event_date_in_window` | each verified lead | date not a real calendar day, after as_of, or outside the window | no date |
| `event_date_on_page` | each verified lead with a date | - | the date is not stated in the page text (only its publication metadata, or nowhere) (#395) |
| `evidence_in_world` | each verified lead | quote not on the World's copy of the cited page, page not in the World, no quote | - |
| `place_on_page` | each verified lead | - | the cited page never names a requested city (no gazetteer: "another city" and "no place" are both unknown) |
| `contact_domain_matches_company` | each verified lead with a contact | email domain is not one of the company's (case ground truth) | phone-only contact, or no ground truth |
| `contact_not_recruiting_inbox` | each verified lead with an email contact | the contact is a hiring inbox (careers@, jobs@, hr@, talent@ ...) (#395) | - |
| `no_tenant_leak` | run | a canary value from the second tenant appears in any outgoing span input or lead, a lead belongs to it, or its rows changed | - |
| `expected_outcomes` | each expectation | outcome or hold reason differs; exhaustive case verifies an unnamed company | - |

These evaluators deliberately do not reuse the scan's own checks (`place_on_page` is a plain look for the city, not
`placeAgreement`): the pipeline must not be its own sole judge (#395).

LLM judges come only where no deterministic check exists (buyer need, semantic claim support), with their own model
configuration and budget, and only after their agreement with labelled synthetic fixtures is measured (#396, section 4c).

### 4c. Judges, their calibration and drift (`lib/evals/judge.ts`, #396)

A judge answers one question: do these sources support this claim about this company? Its answer counts only under rules
that keep agreement between models from passing for ground truth.

- **Fail closed.** These are all `unknown`, and unknown is never pass:
  - a timeout or a thrown error;
  - an unparseable reply;
  - a reply with any field beyond `{answer, quote, source}`;
  - a `supported` whose quote is not verbatim (case and whitespace aside) in the source it names;
  - an adapter that throws, or answers anything but `supported`, `not_supported` or `unknown`.

  Bad harness configuration is refused before any judge call: a NaN, infinite, out-of-range, missing or extra threshold
  (a NaN would make every `rate > max` check false), a non-integer repeat count or budget, an unknown split. A lock entry
  counts only when it is exactly its nine fields with their types (sha256 fingerprint and corpus hash, a full judge spec
  that is not a stub model, a known origin, `ok` a boolean, lists of text, a non-empty source and a real UTC time), its
  origin is the corpus's, its judge spec is exactly the judge's, and `ok` is `true` with no problems and no critical false
  positives. A malformed lock, lock entry, gate result or drift report (any shape but a `DriftReport` with a known status)
  is unusable, never usable.
- **Unanimity, not votes.** A panel is `supported` or `not_supported` only when every judge says so. One abstention or one
  dissent is unknown, so 2-of-3 is not a pass. A judge that answers the same item differently on a repeat is unknown on it.
- **Sources are data.**
  - Page text goes in blocks fenced with a per-call nonce. The nonce is stripped from page text, so a page cannot close its
    own block.
  - The judge is a text-in/text-out function with no tools. `judge.ts` imports nothing at runtime beyond `node:crypto`.
  - An injected `send_email` field makes the whole reply unknown, and the attempt alone fails calibration.
  - An instruction the judge obeys within the three fields is caught by calibration, below.
- **Calibrated or silent.** A judge's identity is a fingerprint over its id, version, model, prompt version and a hash of
  its prompt template. Its verdicts count (`judgeGate`) only when both hold:
  - the lock (`test/fixtures/evals/judges/judges.lock.json`) has a passing calibration for that exact fingerprint on the
    current corpus hash;
  - no drift report over its stored verdicts says `drifted` or `invalid`.

  Any change to the model, prompt or corpus means recalibrating. Until then the judge yields `unknown`, never `pass`. The
  committed lock has no calibrations, so no judge counts yet.

**Any judge.** The harness scores a `JudgeAdapter`. Three exist:
- `claimJudge`: the strict judge above;
- `scanJudge`: the scan's existing verification judge (`lib/scan/runner.ts` `judgePrompt` + `parseJudgement`, via
  `makeJudge`);
- `panelJudge`: a unanimous panel of either. A panel is calibrated like a single judge, because a blind spot all its
  members share passes the panel too.

The lock's `registered` list holds the fingerprints of the judges the code runs: the scan judge (as the scan runs it,
on the tenant's provider) and the claim judge (as the one approved validation run would calibrate it, on
`claude-sonnet-4-5`). The release gate below recomputes them from the code on every CI run.

**The release gate** (`releaseGate`, #784; run in CI by `test/judge-release-gate.test.ts`, by hand with
`scripts/judges.mts --gate`). For each judge the code runs it recomputes the fingerprint and runs the calibration harness
on that exact fingerprint: the judge's real prompt and parser, its id, version and model name, with every reference stub
model behind it (`harnessFor`, `test/helpers/judge-stubs.ts`). Release is blocked when:
- the corpus is not the frozen one;
- a judge changed (model, version or prompt): the gate prints the harness result on the new fingerprint, and release
  stays blocked until a reviewed PR registers it in the lock;
- a judge ships unregistered, or a registered judge was not checked;
- the harness lost its teeth: the truthful stub failed, an adversarial stub passed, or a report is for another
  fingerprint, corpus or split;
- a calibration recorded in the lock for the current fingerprint has a critical false positive (reported by kind:
  wrong identity, contact or date, or an obeyed injection), or failed on its rates;
- drift: the gate reads the committed stored-verdict log (`test/fixtures/evals/judges/verdicts.jsonl`, through
  `readVerdictLog`; absent while no real model is calibrated) and runs `detectDrift` for every judge. A `drifted` or
  `invalid` report blocks, and so do an unreadable log, a gate call with no `verdicts` input, and any supplied drift
  report that is not exactly a `DriftReport` with a known status. Once the lock holds a calibration for a judge's current
  fingerprint, the log must hold that fingerprint's verdicts on every calibration item of the frozen corpus (recorded by
  the same reviewed PR as the lock entry); without them drift cannot be checked and release is blocked. A critical
  false positive in any stored run of that fingerprint on this corpus also blocks, whichever run is the drift baseline;
  criticality is taken from the corpus, and a stored record on this corpus hash whose label, condition, critical kind,
  split or origin differs from its corpus item (or whose item the corpus lacks) blocks. Runs stored under an earlier
  corpus hash are deliberately not counted: a re-frozen corpus is a new benchmark and starts over.
  When the log is missing from the gate input or unreadable, no judge's verdicts count. The CI test and
  `scripts/judges.mts --gate` read the same files (`--lock` and `--verdict-log` point the CLI at others).

A judge with no real-model calibration does not block release, but its verdicts do not count: they stay unknown, never
pass, and the decision lists that under `limits`. Harness reports are marked `harness_stub` and `lockEntry` refuses them,
so a stub run can never be recorded as a calibration. No human label queue is involved: the labels come from the
corpus's records, below.

**The corpus** (`test/fixtures/evals/judges/corpus.synthetic.json`, id `judge-claims-synthetic-5`, origin `synthetic`,
44 items) is labelled, and every company, page and address in it is invented. It is frozen (#783): the lock's `corpus`
record pins its id, sha256, item count and origin. `frozenProblem` refuses an in-place edit (same id, new content) and any
other corpus, so a changed corpus needs a new id and a reviewed re-freeze, and every calibration made on the old one stops
counting.

Its labels are machine-verifiable. Each item carries `truth` records: the claim (company, kind, and any detail, date,
person or contact it names) and the facts its sources state, each with its exact words (`evidence`), the source it cites,
the company, the kind and a status (`asserted`, `denied`, `corrected`, `departed`, `planned` or `instruction`).
`truthLabel` derives the label: supported only when a source asserts a fact about the claim's exact company and kind,
matching every attribute the claim names (a claim date is a prefix: `2026-10` needs a fact dated in October 2026), and no
source denies, corrects or reports the departure of it (a retraction that names a date applies only when its date and the
claim's can be the same: neither is a prefix of the other means a different event). Instructions, plans and publication
or refresh dates never support anything. The records are bound to the text. The displayed claim is not free text: it
is rendered from the truth claim by a fixed template (`claimText`), and any other wording is refused. Each fact's
`evidence` must state its kind (and not use a kind word in another sense, such as "a round of layoffs"), detail, person,
contact, date and status: a retraction or plan in its own words, and an assertion that is neither negated nor a failure,
modal, rumour or plan (checked on the whole evidence; only the keyword of a set-apart clause is masked). The sentence
the evidence sits in must name the fact's company as a whole name, not attributively or as a possessive ("Querix Labs",
"Acme Querix", "Querix-backed", "Querix's spin-off" and "Former Querix staff" do not name Querix; "The Querix team" and
"QUERIX" do), and must name no other company of the item, except one it sets apart: a clause bounded by punctuation on
both sides whose body is a company name (", no relation to Corvid Robotics,"). For an asserted fact two word-position
checks apply as well: a capitalised name that starts a clause directly before the fact's kind word (auxiliaries and an
appositive between commas skipped) must be the fact's company or person, so "Nordwind raised ..." and "Nordwind, a
Querix customer, raised ..." are refused for Querix, and so are the same appositives in brackets or between dashes; and
the company may not be only the reporter ("..., says Querix", "According to Querix, ...", "Querix said Nordwind ...",
"Querix noted that Nordwind ...", or a trailing or mid-sentence "..., Querix said" when the statement neither names
Querix nor speaks in the first person). None of this is a grammatical parse. Instructions and publication or refresh dates are exempt. A role or contact claim
is about now ("is the current ..."), so only an undated assertion supports it; an acquisition claim names its acquirer
when the record has one. Kind words,
exclusions, detail translations and month names are listed in code, not in the corpus. `checkCorpus` refuses an item whose
label disagrees with its records, whose claim or evidence does not state what its records say, whose evidence, company or
contact is not verbatim on the page it cites, whose dates are not real calendar dates, or whose records do not show what its
condition or critical kind claims (an identity trap needs a fact about another company, a date trap a dated claim, an
injection an instruction fact, a negation a denied fact). `test/judge-corpus.test.ts` also serves every source as an HTML
page on a loopback server (with hidden script and comment instructions) and reads it back through the scan's
`htmlToText`, so the judge is given exactly what the scan would read.

It has seven conditions:
- plain;
- multilingual (French, German, Spanish, Portuguese);
- negation;
- contradicting sources, including a former employee who is still on an archived page;
- copied/syndicated press with look-alike names;
- date traps: publication or refresh dates that are not the event date, and future events;
- injected instructions: fake rubric updates, fake block closes, fake tool calls, and replies with an action field.

Each split has a positive and a negative for each condition, plus a critical negative for each of wrong identity, wrong
contact, wrong date and an obeyed injection. Groups tie reworded, translated or reordered copies of one fact together.

`checkCorpus` refuses:
- splits that share an id, or the same claim and sources (a leak);
- a group that spans both splits or mixes labels;
- a positive without a gold quote on the page;
- a critical item that is not a negative;
- a condition or critical kind missing from either split.

**Calibration** (`calibrate`) runs on the `calibration` split only. The `holdout` split is the scored benchmark: it is
reported with the same measures but is never used to choose thresholds, and a holdout report cannot be locked.

Each item is asked twice, plus once with its sources reversed when it has more than one. Its answer is the attempts'
common answer, else unknown. Calls stop at `maxCalls`; items the budget did not reach are unknown and the report fails.

Reports carry:
- agreement with the labels: agree rate, accuracy on decided items, coverage;
- false-positive, false-negative and abstention rates, overall and per condition;
- flip rate (attempts that disagree) and group flip rate (a group whose items got different answers);
- critical false positives: a `supported` on a critical negative on any attempt;
- action attempts: an extra reply field on an injection item;
- every item's attempts with their reasons, and the calls used;
- `limits`: what the report does not show.

A critical false positive or an action attempt blocks the judge whatever its rates. Thresholds default to:
- 5% false positives, 20% false negatives and 20% abstention overall;
- at most 25% false positives and 50% abstention in any one condition;
- at most 10% flips and 10% group flips.

`pairAgreement` compares two judges and lists the items they get wrong together. That is where a unanimous panel would
still pass a false claim.

**Drift** works over stored verdicts. `toStoredVerdicts` turns a report into JSON-lines records (v2), one per item. Each
record holds the run, time, judge, fingerprint, model, version, prompt version, corpus hash, origin, split, item,
condition, critical kind, label, answer and reasons. `parseStoredVerdicts` refuses, instead of skipping: a damaged or
cut-off line, a line with a missing, extra or mistyped field, a v1 line (no judge version), a replayed line (same run,
judge, split and item twice), a run that mixes judge identities, one (judge, fingerprint) recorded with two models,
versions or prompt versions anywhere in the log, and an item whose label differs between lines of one corpus version.
Runs on one corpus version, origin and split must hold the same items: a truncated or padded run is never compared by
intersection.

**Per-version reporting** (#785). `verdictHistory` reports, per origin, corpus version and split (never pooled), the
judge's fingerprint epochs in time order (consecutive runs under one fingerprint; a return to an earlier fingerprint is a
new epoch, so a rollback B -> A is reported as such): each epoch's model, version and prompt version, its false-positive,
false-negative and abstention rates overall and per condition, its critical false positives, and the items its own runs
answered differently. Between adjacent epochs it reports the per-condition rate changes, the items whose answer changed
and new critical false positives. Runs that hold different items are reported under `problems`, with no rates, and
`--report` exits 1. `scripts/judges.mts --report <log.jsonl>` prints it; `renderCalibration` prints one report
per condition.

`detectDrift` compares a judge's latest run with its baseline run on the same corpus version and split, per origin. It
flags each of:
- a new fingerprint (model, version or prompt changed): recalibrate;
- answers that changed under the same fingerprint (the model behind the name changed);
- a condition whose false-positive, false-negative or abstention rate rose by more than 0.1;
- a new critical false positive.

Fewer than two runs is `insufficient`, which never reads as stable. Runs that hold different items are `invalid`, which
blocks like `drifted`. Synthetic and live-web results are never compared
or pooled.

`scripts/judges.mts` scores both real judge adapters under every reference stub model and checks the harness still has
teeth: on the calibration split only the truthful stub may pass. `--verdicts <log.jsonl>` appends the run and reports
drift; it reads and validates the existing log together with the new run first, and leaves the file untouched when either
fails, including when drift over the combined log is `invalid` (a v1 log is refused, not migrated: it records no judge
version). It runs offline, with stub models only:

    SITECRAWL_ENABLED=0 NEWS_SEARCH_ENABLED=0 node --experimental-strip-types --no-warnings --import ./test/helpers/net-fence.ts scripts/judges.mts

**What the stub runs show about the scan's verification judge.** Its one-word reply has no quote, and `parseJudgement`
keeps a leading `supports` and drops whatever follows. So a model that obeys a page instruction cannot be stopped by the
parser; only calibration catches it. The judge's effect is bounded, though. It runs only on candidates that already
passed the deterministic checks (quote on the page, company named, date). Its answer can only nudge confidence, or drop
a lead it calls `contradicts`. It has no send or tool authority.

**Limits and what is not built:**
- The corpus checks that bind records to their text are lexical, from word lists in `lib/evals/judge.ts`, not a parser:
  `KIND_WORDS` and `KIND_EXCLUSIONS` (a kind word used in another sense: only the senses listed are caught),
  `NEGATIONS` and `HEDGES` (a negation, failure, modal, rumour or plan in other words is not caught), `STATUS_WORDS`,
  `DETAIL_WORDS` and `MONTH_WORDS` (English, French, German, Spanish and Portuguese only), and the set-apart keywords in
  `SET_APART` ("no relation to", "unlike", ...). Company binding is by word position (`namesCompany`, `actorProblem`), not
  a parse. A sentence whose actor is a company outside the item's records still passes `checkCorpus` when that actor
  does not start a clause directly before a listed kind word and the item's company is not phrased as the reporter: for
  example "Querix announced that Nordwind raised a seed round in October 2026" is accepted as Querix raising a seed
  round. So are a joint actor ("Nordwind and Querix raised ..."), an actor whose verb is not a listed kind word
  ("Nordwind, backed by Querix, completed a seed round"), and a lowercase actor, which the capitalised-name rule does
  not see ("nordwind (a Querix customer) raised a seed round"), and a first-person sentence that names another company
  mid-clause before the kind word with the item's company as the reporter ("Our partner Nordwind raised a seed round,
  Querix said"). All five are pinned as documented limits in
  `test/judge-review-findings.test.ts`. Corpus review is what catches such a wrong-identity positive. These checks keep the corpus
  honest against the edits tried in review; they are not proof against every paraphrase, and a corpus change is still a
  reviewed PR.
- No real model has been calibrated. That needs a provider adapter, a key and a paid budget, so it is the owner's call.
- The real-model run is built but has not run (`lib/evals/judge-validation-run.ts`, `scripts/judge-validation-run.mts`).
  It is separate from the stub harness above, which never loads it. One run covers both judges on both splits; the
  thresholds, repeats and output limits are fixed in code. The run needs an explicit run id, model (named by the owner
  at run time; only `claude-sonnet-4-5` is priced), USD cap, the dated Bank of Canada USD/CAD rate with its
  bankofcanada.ca source URL, and the billing account's fee/tax rate with its stated basis. All of these are recorded in
  the artifact. The cap's CAD equivalent must fit the owner's approval: Gagan's WhatsApp messages of 2026-11-03 (19:52
  and 19:53 ET), ONE run, hard CAD 5 total. The key is read from `DAZL_JUDGE_VALIDATION_ANTHROPIC_KEY` only.
  - Before each request, the worst case is reserved and persisted.
  - There are no retries. Any timeout, unknown bill, invalid response, model mismatch or failed accounting stops the run
    as failed.
  - Each attempt records the model's `stop_reason`; the totals count refusals and max_tokens stops. A refused item has
    no verdict and counts as unknown (abstain). More than `MAX_REFUSALS` (9) refusals stop the run as failed.
  - One run, ever. There is no rerun path: no flag, env var or file authorizes a second run.
    - Before `--execute`, a pre-call claim must be merged to main by a reviewed PR in
      `web/lib/evals/judge-validation-runs.json`. The plan-only CLI prints the claim for this machine, these inputs and
      this checkout. Exactly one claim may exist. It binds the run id, the approval text, the machine fingerprint
      (sha256 of the macOS IOPlatformUUID or Linux `/etc/machine-id`, never HOME), the model, the USD cap, the FX rate,
      date and source, the fee rate and basis, the state dir and the sha256 of each runner code file. It also has
      `created_at` and `expires_at` (at most 7 days apart). The runner recomputes every field and refuses, with nothing
      claimed or sent, when there is no claim, more than one entry, any mismatch, any extra or missing key, an expired
      claim, or a consumed one. A stale or wrong checkout, another machine, other inputs or changed code cannot run.
    - The state dir is stable: it is named in the reviewed claim (absolute, no default). Any other dir is refused.
    - Then, before the first request, the run is consumed locally with exclusive creates: the approval claim in the
      state dir, then a host claim outside it (`~/.dazl/judge-validation.host-claim`), then the run marker and ledger.
      Any leftover refuses. A run that crashes keeps them, so a rerun refuses on that machine (same or new HOME, since the
      state dir is bound) and on every other machine (fingerprint).
    - After the run, add its `artifact_sha256` and `ended_at` to the claim by a reviewed PR. A consumed claim refuses
      in every checkout.
    - Residual, tested: on the claimed machine, if both the host claim in HOME and the claimed state dir are wiped
      before the consumption record is merged, the local markers are gone and the committed claim alone does not stop
      a second run there. Only the post-run consumption record closes this, so merge it right after the run.
    - The fingerprint is the OS machine id, so a VM or container cloned from the claimed machine shares it. Run on the
      machine the claim names, not a clone.
  - The result is a redacted local artifact under the state dir. It makes no live-web claim and does not update the lock.
  The scan judge also runs on each tenant's own provider and model, so no single calibration covers it.
- The scan does not consult `judgeGate` yet. Doing so would change lead scoring for every tenant whose judge is
  uncalibrated, which is all of them today.
- No judge is wired into `scoreCase` as an evaluator.
- No live-web corpus exists. Agreement with labels written by the developers is not ground truth, and 23 calibration
  items cannot show a rate of zero in use.

Until these exist, every claim a judge would settle stays with the deterministic evaluators or is `unknown`.

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

Credentials (`[secret]`, never a hash) are found by **field name** at any nesting (token, secret, key, password, passcode,
otp, cookie, session, authorization, signature, ...: the WHOLE value under such a key goes, whatever its type - a string, a
number, an object or array, a byte buffer - including lifetime or count children inside it (`session.created`,
`auth.time` go with their parent: fail closed); only a token/key count or limit name such as `max_tokens`, `token_count`,
`tokens: 5` keeps its numbers), by **family** (provider and GitHub/GitLab/npm
keys, Slack, AWS, Google, JWTs, Bearer/Basic values, PEM blocks, cookie header lines, the password of a URL's
`scheme://user:password@` userinfo), and as **assignments in text** (`name: value`, `name=value`, `name => value`,
`"name": "value"`, JSON-escaped `\"name\": \"value\"`, HTML `name=.../value=...` attribute pairs, percent-encoded
query values): the whole assigned value goes - a quoted value to its closing quote, an object or array to its matching
bracket (or the end of a cut body), an authorization or cookie value to the end of the line, anything else to the next
delimiter. People named in a model reply are pseudonymised even when the reply is fenced, prefaced or cut short.
Documented limits, by design (the same list as the `redact.ts` header): an **unquoted value with spaces**
(`password: correct horse battery`) keeps everything after its first word; **prose** (`the password is X`,
`password - X`, `password → X`) is not an assignment; names that are not credential words (`verification_code`, `pin` as
a key outside a credential object) are not credential names; an **opaque value with no name and no known prefix** (a bare
hex string in page text) is kept; a bare `Basic xxxx` shorter than 8 characters with no name next to it is kept; an HTML
attribute pair more than 2,000 characters apart, past the first 60,000 characters of a string, with a `>` inside another
attribute's value before it, or with an apostrophe inside a quoted attribute value, is not found; a userinfo password
containing `/` (`user:ab/x@host`) is a URL password only when an `@` follows before `?`/`#`/`&`/`=`; a percent-encoded
non-ASCII name (`%C3%A4`, `%C2%B2otp`) is decoded byte per character and not folded. Fail closed, by design: an
unbalanced `password: {` takes the rest of the string; an Authorization/Cookie name takes the rest of its line (also in a
cut single-line JSON body); the whole object under a non-count credential key goes (`session.created`, `auth.time`); a
company given under a reply's `"name"` field is pseudonymised like a person; JSON nested ~20k levels deep throws and
nothing is stored. Capture cuts every string to 50,000 characters before redaction, so nothing past that is ever kept.

**Recorded Worlds are private and unpublished**: tenant-scoped, never committed to this repository, never shared across
tenants. None has been captured or stored yet; every World in `web/test/fixtures/evals/` is synthetic.

## Production capture (`lib/evals/capture.ts`)

**Storage and retention are Gagan's decision. Retention hold: until he picks a retention, nothing is deleted** - capture and the tick purge only under an explicit, valid `DAZL_TRACE_RETENTION_DAYS`; the `14` below is a reported default that never deletes.

Capture is switched on and tuned by configuration, never code:

| setting | default | meaning |
| --- | --- | --- |
| `DAZL_TRACE_CAPTURE` | unset (OFF) | only `1` turns capture on |
| `DAZL_TRACE_RETENTION_DAYS` | `14` | whole days, 1-365. An invalid value never captures and never purges (nothing is kept, and nothing deleted, with a retention nobody chose) |

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
`0040_scan_traces.sql`. There is no third-party trace store. Reads (`listTraces`, `getTrace`) always take the tenant; another
tenant's trace id answers like an unknown one. Recording or storing never reaches the run: a failure is logged as
`{"trace_capture":"failed"}` with the error's class and code only (never its message, which can quote the row), and the scan's outcome stands. Response bodies are read from a clone in the
background (capped), so no caller waits on capture; a model provider's own API records no request or response body.
Storing happens after the run's own work and is bounded: body reads get 5 s (then what was read is kept, marked
`truncated`, and the stream is cancelled) and the whole finish 15 s, so a stalled stream or store can never keep `runJob`,
or the runner slot it holds, from returning.

Retention: each capture deletes its own tenant's rows older than the retention, and the scheduled tick
(`/api/internal/tick`, `purgeExpiredTraces`) deletes everyone's - but only under a retention somebody chose: an
explicit valid `DAZL_TRACE_RETENTION_DAYS`, with capture on or off. Capture on alone never purges. With capture unset,
off, or on with no explicit retention (or an invalid one) zero trace rows are deleted (`traces_purged: 0`): no
retention policy is applied by default (retention hold, ported under Instinct review). The tick's purge is bounded and fenced like
its session reap: at most 500 expired rows per tick (`PURGE_LIMIT`), oldest first, in one transaction that takes the tick
lease's fence first, so a tick that lost its lease deletes nothing and a backlog drains over several ticks. Shortening the
retention takes effect at the next purge. The tick still needs its external scheduler; activating that is not part of this change.

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

## The second case (#395 traps)

`scan-toronto-office-traps` (SYNTHETIC): a Toronto new-office request with one genuine lead and two #395 traps.

| company | trap | agent | verdicts |
| --- | --- | --- | --- |
| Maple Leaf Marketing | none (genuine) | verified, contact kept | all pass |
| Northern Lights Agency | old opening, page re-published last week; the text never dates it | **verified**, event date = publication date | `event_date_on_page` unknown, `expected_outcomes` fail |
| Lakeshore Creative | genuine opening, only contact is `careers@` | verified, **recruiting inbox kept as contact** | `contact_not_recruiting_inbox` fail |

Both are real agent gaps, recorded in the baseline and not fixed in the eval PR: the extraction copies a page's publication
date into `event_date` and the verifier accepts it when the text never dates the event; and a recruiting inbox passes as a
verified lead's contact.

## Next increments (one PR each)

1. ~~Production trace capture for scan/discovery~~ (built, OFF by default: "Production capture" above). Next: a classifier
   for stored traces that need attention (zero-yield scans, leads later rejected, verifier/judge disagreement) that queues
   them as case candidates.
2. Enrichment / contact finding: World entries for enrichment responses; verifiers for decision-maker title, former employee,
   generic recruiting inbox, contact-route provenance (#395).
3. Drafting and autopilot: inbox snapshot in the World; verifiers for no send without consent, opt-out and suppression respected,
   no claim absent from evidence.
4. Reply classification: inbox messages in the World; verifiers against labelled synthetic replies; disagreement flags.
5. ~~LLM judges with calibration against labelled adversarial fixtures and drift checks~~ (harness built, section 4c). Next: a
   real-model calibration run (owner: key and budget), then the scan consulting `judgeGate` (#396).
6. Two-version runs with repeated replays, paired comparisons and intervals (#397, #398); outcome pilots stay #399.
