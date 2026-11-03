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
| Owner day / month pool | `DAZL_RUN_MAX_USD_USERS`, `DAZL_OWNER_MONTH_MAX_USD_USERS` (per owner id) | every LLM call of that owner: scan runner and every `ownerGuarded` path | hard dollars, shared store (`tenant_spend_pools`) |
| Per-run (per play) `max_usd` | the scan's `run_budget` | that scan job's LLM calls | hard dollars, saved on the job row per call |
| Trial scan reserve | `DAZL_TRIAL_SCAN_RESERVE_USD` | a trial scan's LLM and TinyFish steps | hard dollars (lib/billing/trial-budget.ts) |
| Trial account total, global daily | `DAZL_TRIAL_ACCOUNT_TOTAL_USD`, `DAZL_TRIAL_GLOBAL_DAILY_USD` | trial admission | hard dollars, checked at admission |
| TinyFish counts | `searchesPerScan`, per tenant per day, global per day, per minute (lib/search/tinyfish.ts) | every TinyFish search/fetch | **count caps, not dollars** (priced only for trial scans) |
| Apollo / PDL counts | `MAX_LEADS = 5`, `MAX_CONTACTS = 5` per scan (lib/enrich/index.ts) | BYOK enrichment | **count caps, not dollars** |

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
| Apollo org enrich, PDL person search (lib/enrich) | BYOK | per-scan count caps | n/a | n/a (counts; credits audit-rowed) |

`test/paid-paths-guarded.test.ts` fails when a new module makes a paid model call without being listed above.

Exclusions:
- **Free sources, not paid:** Greenhouse, Ashby, GDELT, HN Algolia and GitHub (public APIs, no key).
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

- **Scan runner completions** keep their worst-case reservation instead of settling to reported usage.
- **Per-play limits** exist only for scans (`run_budget.max_usd`). Polish, follow-ups and qualification for a play
  count against the owner pool, not a per-play limit.
- **TinyFish and Apollo/PDL** are bounded by counts, not dollars. For BYOK enrichment that is the disclosed limit.
- **Disclosure:** the prelaunch estimate (lib/scan/estimate-request.ts) reads the owner pool rows.
  - Proved: a stale or failed pending marker blocks the estimate with the reason (`accounting_unsettled`), and
    `POST /api/scan` refuses with 409 and creates no job, the same rule the pool enforces. A fresh marker does not block.
  - Still to prove:
    - "already reserved" now includes settled costs, so the label should say "reserved or spent";
    - its included/excluded costs;
    - the "estimate" vs "reported" labels;
    - that the threshold/stop events a user sees match this enforcement.
- **Operator removal of a failed or stale marker** is a manual store edit today.
