# Runtime workers (refs #355)

dazl can add, stop, restart, upgrade and roll back **reviewed** workers while it runs, without a redeploy. This is the
first part of the runtime-worker outcome. Generated code in a sandbox is a separate, default-off change (see "Not in
this change").

## What a worker is

A reviewed module in `web/lib/workers/reviewed/` exports a `definition` and a pure `run(input, { tenantId, signal })`.
The definition (`web/lib/workers/definition.ts`) declares:

- name and semver version;
- input and output schemas, written in a closed JSON-Schema subset (`web/lib/workers/schema.ts`). Objects are closed,
  and a value must be plain JSON data;
- triggers (`enqueue` only today);
- effect class (`none`, `draft`, `send` or `spend`);
- permissions, from a closed list;
- `stateVersion`, the shape of the state it reads and writes;
- timeout and input/output byte caps;
- starting limits: global in-flight, per-tenant in-flight, per-tenant backlog and attempts.

`web/lib/workers/registry.ts` lists every reviewed module in the build, each pinned to the sha256 of its source file.
Modules are imported statically. Nothing is loaded from a path a caller names.

## Registration grants nothing

| Step | Who | Gate |
|---|---|---|
| `register name version sha256` | operator (host CLI) | The (name, version) must be in the reviewed registry. The given hash must equal both the pin and the file on disk. Rows are immutable. |
| `start name version` | operator | The worker must be registered. Its effect must be `none` or `draft`. Every permission must be one this runtime provides, and it provides none today. `send`/`spend` workers can be catalogued but never started (#363). |
| `grant tenant name` | operator | Per-tenant allowlist. The tenant must exist. The grant is also written to the tenant's own `audit_events`. |
| enqueue | tenant session | The tenant comes from the session (`RunUser`) and is never a parameter. The caller needs the `operate` role. The worker must be running and granted. The input must pass the schema and the byte cap. |

Every lifecycle change and every refusal goes into `worker_events` (append-only; UPDATE and DELETE are refused by
triggers). Each row records the actor, action, name, version, code hash, generation and a short detail.
`worker_events` never holds a tenant id.

## Lifecycle and delivery

`worker_deployments` holds one row per worker: the active version, its state (`running`, `draining`, `stopped` or
`failed`), a **generation**, and the limits.

- **Stop (drain)**: no new claims. Claims already in flight may finish. Once none remain, the worker reads `stopped`,
  or it is fenced when the drain deadline passes.
- **Stop (fence), restart, upgrade, rollback**: the generation goes up and every live claim goes back to pending in the
  same transaction. The old holder's finish is then `stale` and writes nothing, and a `complete_stale` event records it.
- **Rollback / upgrade**: allowed only between registered versions with the same `stateVersion`. Queued inputs and
  stored runs stay. Queued work runs on the target version.
- **Crash loop**: after 5 handler faults in a row the worker is set to `failed`. Hosts restart it after exponential
  backoff (`web/lib/queue/backoff.ts`), at most 3 times. After that it stays failed until an operator restarts it.
- **Delivery is at least once.** A result commits in one transaction with the queue transition, and only if (a) the
  queue claim token still owns the item and (b) the worker's version and generation are the ones the claim ran under.
  A host that dies after claiming loses the item when its lease runs out (handler timeout + 2 s), and another host runs
  it.

Limits come from `worker_deployments` on every claim and are counted against committed claims in the shared
`work_queue` (`DbQueue`, #355). They therefore hold across every process: a global in-flight cap per worker, a
per-tenant in-flight cap, and a per-tenant backlog cap at enqueue. They are not per-process numbers.

A host runs a deployment only if the registered hash equals the pin in its own build and the file on disk. Otherwise it
records `host_refused` once and skips that deployment.

## Operating it

```sh
cd web
node --experimental-strip-types scripts/workers.mts list
node --experimental-strip-types scripts/workers.mts register text-stats 1.0.0 <sha256 from list>
node --experimental-strip-types scripts/workers.mts start text-stats 1.0.0
node --experimental-strip-types scripts/workers.mts grant <tenant id> text-stats
node --experimental-strip-types scripts/workers.mts host --concurrency 2       # one or more processes
node --experimental-strip-types scripts/workers.mts stop text-stats [--fence]
node --experimental-strip-types scripts/workers.mts restart|upgrade|rollback ...
```

The actor recorded is `op:<os login>`. Nothing is activated by this change: no host runs and no worker is registered
until an operator does it.

## Not in this change

- **Generated code** (sandbox in a separate OS process; no network, database, keys or inherited env; hard time,
  memory and output caps; outputs are schema-checked proposals; promotion needs recorded fixture tests, review, a
  versioned catalog entry and a per-tenant allowlist). This is the next PR, default-off.
- **Trust boundary (part 1): no capability isolation.** Reviewed workers run in-process, as static imports in the host.
  The guarantee is application-level trust: code review plus the sha256 pin, nothing more. An empty
  `PROVIDED_PERMISSIONS` means the runtime hands a worker no tenant-data, network or model capability, and a worker that
  declares one is refused at start. It is not an OS or VM sandbox: a statically imported module can still import
  `fs`/`net`/`child_process` or read env. CPU and memory are bounded only by the reviewed code and its input caps;
  `Promise.race` cannot stop a synchronous loop, so the runtime cannot kill a runaway worker. Process isolation and
  kill belong to part 2 (generated code).
- `send`/`spend` workers never run here. They need their own send/spend authority, with no automatic retry and
  reconcile-before-retry (#363). SpendGuard coverage is unchanged by this work.
- No worker is wired to a tenant trigger yet. The tenant route `web/app/api/workers/route.ts` (POST enqueue, GET list)
  is in this change and only reaches workers an operator granted to the workspace; the first worker a tenant should
  trigger comes later.
