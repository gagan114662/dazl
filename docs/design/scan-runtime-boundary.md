# Scan runtime boundary matrix (#997, C1 of #920)

This is characterization of the current runtime, not a database cutover or a change to supported product scope.
#992 and #993 delivered engine-neutral first5 and whole-payload readers. They do not make the raw SQLite scan
writer, gate writer or runner PostgreSQL-capable. Parent #920 remains open for its original both-store production
read-path/fault acceptance and the remaining writer/runner/HTTP qualification.

## Current selection

| Configuration | Control plane (sessions, membership, plans, budget) | Scan domain (jobs, leads, gate, status/reap, execution) | Scan queue |
|---|---|---|---|
| `DATABASE_URL` absent or empty, shared queue off | SQLite shared Db | Raw SQLite | Legacy claimer, or single-tenant canary queue on raw SQLite |
| Same, `DAZL_SCAN_SHARED_QUEUE=1` | SQLite shared Db | Raw SQLite | Same raw SQLite handle, overriding the canary flag |
| `DATABASE_URL` configured, shared queue off | PostgreSQL shared Db | Raw SQLite | Legacy or single-tenant canary queue on raw SQLite |
| Same, shared queue exact `1` | PostgreSQL shared Db | Raw SQLite | PostgreSQL shared Db, separate from the raw domain |

The last row is the documented single-instance engineering transition in `docs/PLATFORM.md`, not production
cutover readiness. `checks.split` still prevents calling the application ready for a PostgreSQL domain cutover.
`DATABASE_URL` selects the shared store, NOT the scan domain. A blanket guard treating any configured URL as an
unsupported scan domain would break existing transitional behavior and could strand work. No such guard is added.
There is currently no production selector for a PostgreSQL scan domain. Do not add a dead opt-in flag or route
status reads to the shared store while writes and execution still use the raw domain.

## Request and ownership chain

- `scan/service.requireUser` reads the cookie through real `auth-db.getSessionUser` on the selected control store.
  The session's active membership selects `tenantId`; the actor's id is not a substitute for workspace ownership.
- The status GET captures one `raw = getScanDb()`. Its legacy `getJob(raw, tenantId, jobId)` reaps before owner lookup.
  An invalid-format id does not call getJob. A foreign or missing well-formed id can still cause that legacy global
  reap before returning 404. A passive request means no runner kick, NOT a read-only transaction.
- The complete response is `readScanStatus(sqliteDb(raw), tenantId, jobId)`, never a newly selected shared domain.
  Enrichment, provisional rows and durable gate-failed holds retain their existing meaning.
- A non-passive pending job schedules `after(() => kickRunner(raw))`. Queue selection inside that runner remains
  separate from domain selection. The shared queue flag takes precedence over canary selection.
- Reserved/unsettled spend from any attempt must not be silently retried or handed back into a rebill. Existing
  reaper, binding, claim token, attempt ownership, slot and shutdown fences remain unchanged.
- Shutdown handles only this process's owned attempts. With a separate PostgreSQL queue, it does not rewrite that
  queue using the raw SQLite handle; its lease returns the queue claim. Do not disable shutdown cleanup merely
  because `DATABASE_URL` is configured.

## Evidence and limits

`test/status-runtime-boundary.test.ts` launches the production HTTP handler with the production scan service,
authentication, membership, read service and runner. The loader substitutes only physical SQLite opening and
request-scoped cookies/after, not requireUser or business logic. Its two engine variants concern the CONTROL/QUEUE
store; the scan domain is deliberately SQLite in both. The PostgreSQL variant must execute on real loopback test
PostgreSQL before acceptance; a conditional skip is not proof.

The fixture uses a member actor distinct from its active workspace, a separate control-store plan and sessions,
and a same-id contradictory control-store scan. It checks unauthorized/revoked 401, invalid/missing/foreign 404,
passive global reaping, held/provisional/enriching/terminal responses, earlier-attempt reserved-call refusal, and
actual non-passive dispatch/queue ownership. SQLite's absent/empty/configured URL cases use an explicitly injected
control store. The configured-URL SQLite variant is an injected selection control, not a PostgreSQL claim. Real
PostgreSQL exercises configured-URL control/queue behavior. The stored plan and contradictory job remain unchanged.
The production selected-store cache is injected via existing `setDb`, not a test of opening a production URL.

Existing `status-route-kick`, `enriching-stage`, `scan-status-read-service`, `scan-claimer`, `queue-tenant-gate`,
`shutdown-requeue`, `scan-reap-uncertain-spend` and `queue-bind-uncertain` suites are regression gates for direct
execution, lease/attempt/tenant ownership, reserved-call and cleanup behavior. Network is fenced and all data and
credentials are synthetic; a claimed attempt ending `budget_stopped` is the observable dispatch control, not a
successful provider scan.

No domain reacquisition defect was demonstrated in this characterization. No new production abstraction is needed
merely to rename the one raw handle already captured by the route. Any later C2 production change needs its own
counterexample and qualified scope. Full PostgreSQL domain HTTP support still needs the writer/runner cluster port
and actual mutation/fault/ownership qualification described in `docs/PLATFORM.md`; C1 does not close #920, activate
PostgreSQL, change auth storage, deploy anything, call providers or spend money.
