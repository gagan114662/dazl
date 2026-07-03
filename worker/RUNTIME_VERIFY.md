# Runtime Verification — Phase 1 Durability Proof (Local)

This is a **local-only** verification, run against `wrangler dev --local` (miniflare),
with no Cloudflare account, login, or real cloud resources involved. It proves that an
employee's goal and memories persist across a full Worker process restart, using the
local D1 + Durable Object storage under `.wrangler/state`.

## Setup

`worker/wrangler.toml`'s `[[d1_databases]]` `database_id` was changed from the
placeholder `PLACEHOLDER_RUN_WRANGLER_D1_CREATE` to a dummy UUID
`00000000-0000-0000-0000-000000000000`, since `wrangler dev --local` requires a
syntactically valid ID but never contacts Cloudflare for it. No real D1 database was
created (no `wrangler d1 create`, no `wrangler login`).

Migrations were applied locally:

```
$ npx wrangler d1 migrations apply dazl --local
Migrations to be applied:
┌───────────────┐
│ name          │
├───────────────┤
│ 0001_init.sql │
└───────────────┘
? About to apply 1 migration(s)
Your database may not be available to serve requests during the migration, continue?
🤖 Using fallback value in non-interactive context: yes
🌀 Executing on local database dazl (00000000-0000-0000-0000-000000000000) from .wrangler/state/v3/d1:
🚣 4 commands executed successfully.
┌───────────────┬────────┐
│ name          │ status │
├───────────────┼────────┤
│ 0001_init.sql │ ✅     │
└───────────────┴────────┘
```

The worker was started with `npx wrangler dev --local --port 8787` and confirmed ready
(bindings for `EMPLOYEE` DO, `EMPLOYEE_CYCLE` Workflow, and `DB` D1 all resolved locally).

## Step 1: Spawn an employee

Command (run 2026-07-03, ~14:58 EDT):

```
$ curl -s -X POST localhost:8787/employees -d '{"employeeName":"researcher","role":"Analyst","goal":"study dazl.ai market"}' -w "\nHTTP_STATUS:%{http_code}\n"
```

Output:

```
{"started":true}
HTTP_STATUS:200
```

**Proves:** the `POST /employees` route accepted the request, created/initialized the
`EmployeeState` Durable Object for `researcher` with the given goal, and kicked off an
`EmployeeCycle` Workflow instance.

## Step 2: Inspect after ~10s (before restart)

Command (2026-07-03 14:58:37 EDT):

```
$ curl -s localhost:8787/employees/researcher -w "\nHTTP_STATUS:%{http_code}\n"
```

Output:

```
{"employeeName":"researcher","goal":"study dazl.ai market","memories":[{"id":1,"employeeName":"researcher","kind":"lesson","content":"Observed while researching: <!doctype html><html lang=\"en\"><head><title>Example Domain</title><link rel=\"icon\" href=\"data:,\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><style>body{background:#eee;width:6","createdAt":1783105104}]}
HTTP_STATUS:200
```

**Proves:** the `EmployeeCycle` Workflow (Plan→Act→Reflect) **did execute under local
miniflare** — it fetched `example.com` (visible in the truncated HTML in `content`),
and the Reflect step persisted a `kind: "lesson"` memory to D1 via the memory DAL. The
`GET /employees/:employeeName` route correctly joins the DO's goal with D1-recalled
memories. This is the full Phase-1 loop working end-to-end locally, not just a stub.

The dev server log corroborates:

```
[wrangler:info] POST /employees 200 OK (36ms)
[wrangler:info] GET /employees/researcher 200 OK (15ms)
```

## Step 3: Restart the Worker process

```
$ pkill -f "wrangler dev --local --port 8787"   # (PID 60741 killed; port 8787 confirmed free)
$ npx wrangler dev --local --port 8787          # fresh process, PID 61063
[wrangler:info] Ready on http://localhost:8787
```

This is a full process kill and restart — a brand-new `wrangler dev` process, not a
reload — so any in-memory-only state would be lost. Local D1 and DO storage persist to
disk under `worker/.wrangler/state`, which survives the restart.

## Step 4: Inspect after restart (durability proof)

Command (2026-07-03 14:59:35 EDT, ~1 minute after the original spawn, on the **new**
process):

```
$ curl -s localhost:8787/employees/researcher -w "\nHTTP_STATUS:%{http_code}\n"
```

Output:

```
{"employeeName":"researcher","goal":"study dazl.ai market","memories":[{"id":1,"employeeName":"researcher","kind":"lesson","content":"Observed while researching: <!doctype html><html lang=\"en\"><head><title>Example Domain</title><link rel=\"icon\" href=\"data:,\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><style>body{background:#eee;width:6","createdAt":1783105104}]}
HTTP_STATUS:200
```

**Proves durability:** the goal (`"study dazl.ai market"`) and the exact same memory
record (`id: 1`, `createdAt: 1783105104` — byte-identical to the pre-restart read, not
a freshly regenerated one) are still present after the Worker process was fully killed
and restarted. The `EmployeeState` Durable Object and D1 memory table both persisted
their state to `worker/.wrangler/state` across the restart, which is the Phase-1
success criterion: **an employee's goal and memories survive a server restart.**

## Cleanup

The restarted `wrangler dev` process (PID 61063) was killed after the verification.
Confirmed via `lsof -i :8787` (no output — port free) and `ps aux | grep wrangler`
(no matching process) that no dev server was left running.

## Notes / caveats

- This is a **local-only** proof (miniflare via `wrangler dev --local`). No Cloudflare
  account, login, or real D1/DO/Workflow cloud resources were touched or created.
- The `database_id` in `wrangler.toml` is now a dummy UUID rather than the
  `PLACEHOLDER_RUN_WRANGLER_D1_CREATE` string. It will need to be replaced with a real
  ID (`npx wrangler d1 create dazl`) before any real deploy.
- Local persistence used `worker/.wrangler/state` (gitignored, not committed).
