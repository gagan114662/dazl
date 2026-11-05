# Lookalike discovery from customer outcomes (#386)

`lib/scan/lookalike.ts` annotates leads the tenant already has against its own past fit-4+ / interested-reply leads:
model guesses, keyword overlap, no search. This change adds discovery that starts from real outcomes instead.

## Flow

1. **Import** (`POST /api/scan/lookalike`, role `operate`). The body is `{ examples: [{ kind, name, domain?, industry?,
   size?, location?, description? }] }`. `kind` is `customer`, `won`, `negative` (a lost or bad-fit account) or
   `competitor`. Up to 100 accounts. If any row is malformed, or the import has too many accounts, the whole import is
   refused and the response names the row. Nothing is stored, searched or charged at this step.
2. **Model** (`lib/scan/lookalike-discovery.ts`, pure). The model needs at least 5 customers/won AND at least 5
   negatives/competitors. Customers alone cannot show what sets them apart. A feature (industry, size, location, or a
   description keyword) is a discriminator only when at least 2 customers share it and its add-one smoothed rate among
   customers is at least 2x its rate among the negatives. The model keeps the top 12 discriminators. Each one carries a
   reason, in the form `keyword "orthodontic": <n> of <customers> customers, <lift>x vs non-customers`.
3. **Held-out check.** The accounts are split deterministically by account key (30% held out). Features are derived on
   the training part only. They then pick held-out accounts (fit >= 0.35), and the precision of those picks is
   compared with the base rate. If no feature discriminates, too few accounts are held out (fewer than 2 per class), or
   precision does not beat chance, the response is `unvalidated`: no model and no profile. When the check passes, the
   model is refit on every example. The held-out numbers describe the training-only model.
4. **Profile.** The route returns `{ query, icp }` for the normal `POST /api/scan`. The discriminating industries, sizes
   and places become the profile's own fields, and the keywords go into the request text. The profile adds no intent
   signal. A `lookalike` block travels inside `scan_jobs.icp` (no schema change, same pattern as the #379 research
   block). It holds the discriminators, the held-out numbers, and 5-char hashes of every supplied account's name key
   and domain. The block is size-checked whole (`budgetedIcp`) and never sent to a model (`flatProfile` strips it).
   `normalizeIcp` refuses a profile whose block is present but malformed, so a scan never runs without the exclusions
   its profile claims to carry.
5. **Retrieval.** The ordinary scan pipeline runs: search, extraction, the verifier, every date, identity and contact
   gate, and grading. Lookalike discovery changes none of these.
6. **Net-new only** (`lib/scan/runner.ts`). Before the verifier, candidates matching a supplied account are dropped and
   recorded as `lookalike_supplied_customer`, `_competitor` or `_negative` in the run report and the job's drop reasons.
   No page is fetched for them. A candidate matches when its company name key, or its explicit company domain, or the
   source page's host *when that host is the company's own domain* (`companyOwnsDomain`) equals a supplied account's
   key. A news site that hosts an article is not the company. `finish()` checks every stored row again, including
   fallback and walled rows. If the stored block is unreadable, every candidate is dropped (`lookalike_unreadable`).
7. **Label** (`GET /api/leads`, `lookalike_fit`). Fit is the share of discriminating weight found in the lead's **own
   evidence**: company, signal and the verbatim excerpt. It is never computed from the search inputs or the grader's
   rationale, which would only echo the profile back. `readiness` is `lookalike_with_event` only when the existing
   timing proof marks the lead `proof_backed` and it is not in review. Otherwise it is `lookalike_only`, labelled
   "Lookalike fit only - no verified current intent". Lookalike fit never changes fit, intent, grade, ranking or any
   gate.

## Measurement

`compareToBaseline` reports precision@k for the lookalike ordering (`orderByLookalike`) and the ordinary-ICP ordering
(`orderByIcp`, which counts the profile's own industry, size and place terms) on the same labelled candidates, plus
the lift between them. This is the #372 benchmark shape. The tests run it on a synthetic fixture only: lookalike 1.0
vs ICP 0.4 at k=5. That shows the metric works. It is not a measured product result. A live measurement needs a real
customer list and the #372 benchmark.

## Known limits

- A candidate named differently on a third-party page from the supplied account (`Acme` vs `Acme Holdings`), with no
  company domain yet, is not matched. That needs the canonical account graph (#364).
- A same-name business on another domain is excluded (fails closed).
- The block is client-supplied through `POST /api/scan`, like the rest of the reviewed profile. A tenant can forge
  only its own labels and exclusions. Nothing else trusts the block.
- There is no import screen yet. The import is the API only. The lead card shows `lookalike_fit` when present.
- Negatives must be supplied. Explicit rejections recorded by #385 (PR #596) are a natural negative source once that
  lands. That is not wired here, so this branch is independent of #596.
