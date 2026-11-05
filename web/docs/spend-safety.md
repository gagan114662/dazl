# Spend safety: paid callers, limits and the pool contract (#363)

This is the inventory of every place dazl makes a call that costs money. For each one it gives who pays (the
principal), what limits it, how it reserves and settles, and what is excluded. The enforcement is in code; this page
says what that code does. It is not a pricing page and makes no billing claim.

## Principals

- **BYOK**: the tenant's own key (LLM key, Apollo or PDL key). The tenant's vendor bills them; dazl's limits bound
  what dazl will spend on their behalf.
- **Platform-funded**: dazl's own keys. These are the free-trial scan's LLM key and the TinyFish key, which every scan
  uses for search and fetch.

## Limits

| Limit | Set by | Applies to | Kind |
|---|---|---|---|
| **Hard per-scan cap** (#377, #533) | owner rule: CAD 5 per paid scan; `DAZL_SCAN_CAP_CAD` can only lower it | every paid provider call of one scan (all attempts, retries, workers, post-finish enrichment, owner retry of its held lookups) | hard dollars, reserved on the scan's own row before each call (below) |
| Owner day / month pool | `DAZL_RUN_MAX_USD_USERS`, `DAZL_OWNER_MONTH_MAX_USD_USERS` (per owner id) | every LLM call of that owner: scan runner and every `ownerGuarded` path | hard dollars, shared store (`tenant_spend_pools`) |
| Per-run (per play) `max_usd` | the scan's `run_budget` | that scan job's LLM calls | hard dollars, saved on the job row per call |
| Trial scan reserve | `DAZL_TRIAL_SCAN_RESERVE_USD` | a trial scan's LLM and TinyFish steps | hard dollars (lib/billing/trial-budget.ts) |
| Trial account total, global daily | `DAZL_TRIAL_ACCOUNT_TOTAL_USD`, `DAZL_TRIAL_GLOBAL_DAILY_USD` | trial admission | hard dollars, checked at admission |
| TinyFish counts | `searchesPerScan`, per tenant per day, global per day, per minute (lib/search/tinyfish.ts) | every TinyFish search/fetch | **count caps, not dollars** (priced only for trial scans) |
| Apollo / PDL counts | `MAX_LEADS = 5`, `MAX_CONTACTS = 5` per scan (lib/enrich/index.ts); 50 companies per commenter batch | BYOK enrichment, one pass | **count caps, not dollars** |
| Workspace enrichment credits | **no default limit**; per-workspace explicit limit (Settings > Enrichment, `tenant_spend_pools` periods `cla|clp` + `d|m`), else an operator-wide `DAZL_APOLLO_CREDITS_DAY` / `_MONTH`, `DAZL_PDL_CREDITS_DAY` / `_MONTH`, else unset = only the per-scan caps bind (usage still counted) | every Apollo org lookup and PDL person search, any pass, job, retry, restart or instance | **credits (counts), not dollars**, shared store (`tenant_spend_pools`, periods `cad:`/`cam:`/`cpd:`/`cpm:`; lib/enrich/credit-pool.ts) |

With no owner limit set, `ownerGuarded` returns the provider unchanged: the owner paths are then bounded only by
the vendor and the tenant's own key.

## Paid callers

| Caller | Principal | Guarded by | Reserve | Settle |
|---|---|---|---|---|
| Scan runner LLM completions (score, buyer fit, verification) (lib/scan/runner.ts) | BYOK, or platform for trial | per-run guard + owner pool + trial guard (`guardProvider`) | worst case per call (prompt bytes or token count + margin, `max_tokens` out) | **not settled**: keeps the worst case |
| Scan runner model web research | BYOK | refused whenever any of those guards applies (its cost has no bound); runs unguarded only with no limit set | n/a | n/a |
| Reply intent and reply drafts (lib/replies/threads.ts) | BYOK | owner pool (`ownerGuarded`) | worst case | settled to the reported cost (below) |
| Draft polish (lib/outreach/draft-llm.ts) | BYOK | owner pool | worst case | settled |
| Follow-up and sequence text (draft-llm.ts, lib/outreach/sequences.ts) | BYOK | owner pool | worst case | settled |
| SEO briefs and newsjacks (lib/seo/brief.ts, newsjack.ts) | BYOK | owner pool | worst case | settled |
| ICP from the seller's website (lib/scan/icp-from-site.ts) | BYOK | owner pool | worst case | settled |
| Lead qualification (lib/scan/qualify-run.ts, lead-qualify.ts) | BYOK | per-call approval (exact prompt hash and estimate) + owner pool | worst case | settled; claim kept on any post-call failure |
| TinyFish search / fetch (lib/search/tinyfish.ts) | platform | count caps (all scans); trial reserve at a listed per-call price (trial only) | counted before the call, in one transaction with the cap check | n/a (counts) |
| Apollo org enrich, PDL person search (lib/enrich/index.ts) | BYOK | per-scan count caps + workspace credit pool | Apollo org: 1 credit; PDL: the search size (up to 5), before the per-job claim and the call | Apollo: a returned organization settles to 1 charged; no match or an error keeps the reservation. PDL: settles to the profiles returned; an error keeps all of it. A replayed claim (no call) is refunded |
| Commenter import org and PDL lookups (lib/scan/commenter-import.ts) | BYOK | per-batch cap (50 companies) + workspace credit pool | same as above (PDL: 5) | same as above; a refusal is one audit row (`credit_cap` / `credit_unsaved`) and stops that provider's paid lookups for the batch |
| Apollo people search (`mixed_people/api_search`) | BYOK | per-scan call cap | not reserved: documented as 0 credits | n/a |

`test/paid-paths-guarded.test.ts` fails when a new module makes a paid model call, or a credit-charging Apollo/PDL call
without reserving on the workspace credit pool, without being listed above. `test/enrich-credit-pool.test.ts` covers the
credit pool on both engines and through both callers with stubbed providers.
Inside a scan, every row above that is a paid provider call also reserves on the hard per-scan cap (next section).

## The hard per-scan cap (lib/scan/spend-cap.ts)

The owner's rule: one paid scan may not spend more than CAD 5. It is enforced at the transport of every paid provider
(model completions in `lib/llm/provider.ts`, TinyFish search and fetch, Apollo, PDL, the rendering service), before the
request, against a durable record on the scan's own job row. The runner opens the scan's context around the whole
attempt (`runJob`), so every paid call made for the scan finds it; outside a scan the transports are unchanged and the
paths keep the guards above.

1. **Reserve before the call**, in one transaction: `scan_jobs.spend_cap_reserved_usd` is raised by the call's worst case
   only `WHERE` the new total still fits the scan's cap, for this job id, its tenant and the attempt that owns it, and the
   call's own `scan_spend_calls` row is written (`reserved`). Two workers on one scan cannot pass the cap together (the
   Postgres row lock re-checks the condition; SQLite transactions are IMMEDIATE).
2. **Refused** (over the cap, another tenant's or an unknown job, a lost attempt, a finished-and-failed job, a malformed
   setting or price, an unlisted model, a store that does not answer): nothing is sent, the refusal is a `refused` row
   with its reason and the job's `spend_cap_refusals` count, and the caller gets `SpendRefused`. A scan whose model call
   is refused ends `budget_stopped`; a refused TinyFish call reads as its count cap; a refused render renders nothing;
   a refused Apollo/PDL lookup is a failed lookup (its claim holds, as any failed lookup's does), and
   its workspace credit reservation is refunded, because no request was sent.
3. **Settle once**, after the call, to the vendor-reported cost (`settled`); a replay changes nothing. A failed call, or
   one with no usable cost, keeps its full worst case (`kept`). A crash between reserve and settle leaves `reserved` at the
   worst case, which every later attempt of the scan still counts: never released.
4. **The cap**: `DAZL_SCAN_CAP_CAD` (default and hard ceiling 5; higher values are clamped) over
   `DAZL_SCAN_CAP_FX_CAD_PER_USD` (default and floor 1.50 CAD per USD; lower values are clamped), so USD 3.3333 at most;
   the column's CHECK holds the same bound. The scan's own `run_budget.max_usd` only lowers it, and the first cap a scan
   reserved under is stored on its row, so a later attempt under a looser setting cannot raise it.
5. **Worst-case prices** (USD; each env-overridable, a malformed value refuses):

| Kind | Default worst case | Setting | Source |
|---|---|---|---|
| model completion | (prompt UTF-8 bytes + 1,000) x input price + `max_tokens` x output price, requested model | price table in `lib/scan/spend-cap.ts` | claude-sonnet-4-5 3 / 15 per 1M (Anthropic pricing); gpt-4.1 3.50 / 14.00 per 1M (OpenAI Priority rate; Standard is 2 / 8) |
| TinyFish search / fetch | 0 inside the free allowance (12,000 searches, 1,000 URLs per UTC day); a global daily cap above it is refused unless priced | `DAZL_SCAN_PRICE_TINYFISH_SEARCH_USD`, `_FETCH_USD` (else the trial's `DAZL_TRIAL_TINYFISH_*_USD`) | TinyFish docs, Billing |
| Apollo organization enrich | 0.20 per request (1 credit) | `DAZL_SCAN_PRICE_APOLLO_ORG_USD` | Apollo add-on credit price; API pricing doc: 1 credit |
| Apollo people search | 0.20 per request (1 credit, although the doc lists 0; legacy plans can differ) | `DAZL_SCAN_PRICE_APOLLO_PEOPLE_USD` | as above |
| PDL person search | 0.28 per profile, reserved for the size asked for, settled to the profiles returned (a 404 is not billed) | `DAZL_SCAN_PRICE_PDL_PROFILE_USD` | PDL Pro tier-1 monthly price |
| rendering service | 0.01 per render (Browserless: 2 units of 30 s at 0.0020) | `DAZL_SCAN_PRICE_RENDER_USD` (0 for a self-hosted renderer) | Browserless pricing |

Any other model is refused before the call. `test/scan-spend-cap-paths.test.ts` lists every paid host and transport
and fails when a new endpoint appears unclassified or a paid one is called from a module without the gate;
`test/scan-spend-cap.test.ts` (both engines) and `test/scan-spend-cap-runner.test.ts` prove the ledger and the runner.

Not covered by the cap: paths that are not a scan (replies, drafts, SEO, previews, the ICP-from-website read, CRM push)
and the LinkedIn commenter import's company enrichment (lib/scan/commenter-import.ts, its own count cap of 50 lookups).
Those keep the guards listed above.

Exclusions:
- **Free sources, not paid:** Greenhouse, Ashby, Lever, GDELT, HN Algolia and GitHub (public APIs, no key); Jina Reader
  (lib/scrape/jina.ts, lib/sources/jina.ts) is called without a key (its free, rate-limited tier) and capped per scan /
  per hour; YouTube Data API uses the operator's free quota.
- **Not dazl's spend:** Gmail and Google OAuth (the tenant's mailbox), HubSpot and Pipedrive (CRM push with the
  tenant's own token), and Stripe (billing itself).
- **Offline eval tooling:** `lib/evals/trace.ts` is never in the app.

## The owner pool contract (lib/llm/spend-pool.ts, spend-guard.ts, owner-guard.ts)

1. **Reserve before the call.** The call's worst case is raised in the day and month rows, but only `WHERE` it still
   fits the limit, under the row lock, in one transaction with every window. Two more things happen in the same
   transaction:
   - the reservation is refused if any pending-settlement marker of the owner exists;
   - otherwise the call's own marker (period `p:<id>`) is written.

   Refused: no call.
2. **One unsettled call per owner.** A reservation that meets an open marker waits for it, for a bounded time
   (`ownerGuarded`: 10 s, `DAZL_SPEND_BUSY_WAIT_MS`; the scan runner: up to the in-flight deadline), then is refused
   `busy`.
   - A marker older than `PENDING_STALE_S` (5 min; a completion times out after 150 s), or one marked failed, refuses
     with `accounting_unsettled` until an operator removes it.
   - Removing it does not touch the reservation in the windows, so the uncertain cost is never released.
3. **Settle after the call**, in one transaction that removes the marker. The cost basis:
   - the **served** model's listed price (a dated id is priced as its alias);
   - input and output tokens;
   - cache writes at 2x input (the higher listed write price; the usage does not say which);
   - cache reads at 0.1x.

   An overrun is recorded past the limit and refuses every later reservation. A retry after a partial failure is a
   no-op once the marker is gone. A missing window row throws instead of changing nothing.
4. **No usage:** the worst-case reservation stands and the marker goes.
5. **Unknown cost** (an unpriced served model, or invalid counts): the day counts as spent; the month keeps the
   reservation.
6. **Provider error:** the reservation stands (the vendor may have billed it) and the marker goes.
7. **Settle cannot be saved** (retried once): the call's result is withheld with `SpendAccountingFailed`. This is
   never a `SpendRefused`, so qualification keeps its claim and is not re-billed.
   - The marker is marked failed at once.
   - If the store is down for that too, the process writes it before its next reservation for the owner and retries
     every 5 s.
   - Until it is written, the still-open marker refuses everyone (rule 2).

Every state above is a row in `test/spend-state-matrix.test.ts` (calls, pool rows, next admission, qualification
claim), on both engines, including two SQLite connections to one file as two instances.

## Not covered yet (#363 stays open)

- **Scan runner completions** now settle to the vendor-reported usage (owner pool and job run budget; trial scans unchanged and OFF). A call whose cost could not be saved ends the scan as `accounting_failed` (never retried, never an empty result). The runner writes no pending marker, so a crash leaves its worst-case reservation counted and a later attempt only adds to it.
- **OpenAI is not supported under an owner pool or run budget**: no OpenAI model is in the price table (`PRICES_USD_PER_M` holds only `claude-sonnet-4-5`), so every reservation is refused `model_unpriced`. The default `gpt-4.1` is listed at $2 / $8 per 1M input / output tokens on https://developers.openai.com/api/docs/models/gpt-4.1 (marked Deprecated there); it was NOT added, because OpenAI usage counts cached input inside prompt tokens and the settle math was written for Anthropic's usage fields.
- **Per-play limits** exist only for scans (`run_budget.max_usd`). Polish, follow-ups and qualification for a play
  count against the owner pool, not a per-play limit.
- **TinyFish and Apollo/PDL** are bounded by counts, not dollars, outside a scan (inside one, the hard per-scan cap
  also prices them). For BYOK enrichment that is the disclosed limit: the workspace credit pool (day/month credits per
  tenant) is persistent and atomic. Each workspace sets its own day/month limits in Settings > Enrichment (an
  operator env value is the fallback per window); #363 is only PART done: scan-runner settle, per-play caps, the
  cost-disclosure threshold and live acceptance of reserve-before-call on real paid paths remain.
- **Credit holds** are rows in `tenant_spend_pools` (period `ch:<9 base36>`, units/time/provider stored on the row). Settled or refunded holds are deleted in the same transaction as the pool move. A hold whose charge is unknown (crash, failed or unanswered call) KEEPS its row and its reservation: those rows are never pruned automatically. Growth is one small row per unknown-charge lookup; any later cleanup needs explicit retention authority and must not release an unsettled reservation.
- **Export and deletion of credit records**: the tenant export translates credit limit, usage and hold rows into labelled credit records (provider, window, credits, reservation time; `tenant_spend_pools(credit rows).reserved_usd/reported_usd/calls/period` listed in `redacted_columns`, scoped to credit rows; USD pool rows export raw), never credits or an epoch as USD. Deletion scope is unchanged: the rows are erased with the tenant, including an unsettled hold. No retention or pruning was added; whether an unsettled hold should outlive deletion is an owner decision (not made).
- **Disclosure:** the prelaunch estimate (lib/scan/estimate-request.ts) reads the owner pool rows.
  - Proved: a stale or failed pending marker blocks the estimate with the reason (`accounting_unsettled`), and
    `POST /api/scan` refuses with 409 and creates no job, the same rule the pool enforces. A fresh marker does not block.
  - Still to prove:
    - "already reserved" now includes settled costs, so the label should say "reserved or spent";
    - its included/excluded costs;
    - the "estimate" vs "reported" labels;
    - that the threshold/stop events a user sees match this enforcement.
- **Operator removal of a failed or stale marker** is a manual store edit today.
