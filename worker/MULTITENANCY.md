# Multitenancy

Dazl's runtime is now tenant-isolated end to end: one worker deployment serves
many customer organizations, and every piece of tenant-owned state — roster
rows, memories, Durable Objects, workflow instances, the sandbox brain, R2
snapshots, API keys — is namespaced by `tenant_id` with no shared path
between tenants.

## Credential model

Two credential kinds, both `Authorization: Bearer <token>`:

| Credential | Scope | Used for |
|---|---|---|
| `DAZL_API_SECRET` (operator secret) | Admin, no tenant | Provisioning tenants, minting/revoking keys, legacy default-tenant routes |
| Per-tenant API key (`dazl_…`) | Exactly one tenant | The tenant-scoped `/v1` API |

Tenant provisioning is admin-only by design: `/v1/tenants` with the operator
secret mints the tenant's first API key. The full key is returned exactly
once; only its SHA-256 digest is stored in `api_keys`, so a D1 leak does not
leak usable credentials. A request's tenant is always derived from the key
lookup — never from a `tenantId` in the request body (forged values are read
and ignored; see `test/multitenancy.test.ts`).

## API surface

```
POST   /v1/tenants                        (admin)  create tenant, returns one-time apiKey
POST   /v1/tenants/:tenantId/api-keys     (admin)  mint an additional key
DELETE /v1/api-keys/:keyId                (admin)  revoke a key
POST   /v1/employees                       (key)    hire/re-goal employee + start cycle
GET    /v1/employees                       (key)    list calling tenant's roster
GET    /v1/employees/:employeeName         (key)    inspect goal + recent memories
```

The pre-multitenancy routes (`POST /employees`, `GET /employees/:name` with
`DAZL_API_SECRET`) still work, scoped to the `default` tenant, and are
deprecated in favor of `/v1`.

## Isolation mechanics

Isolation is enforced by EVERY query and binding being tenant-scoped (below)
and by the test suite proving it — the composite keys enable the
namespacing, but a mis-scoped query would still leak, so the tests are the
real guarantee.

- **D1**: `employees` PK is `(tenant_id, employee_name)`; `memory` and
  `api_keys` carry `tenant_id` and every query filters on it. Two tenants can
  hire identically-named employees with zero interaction.
- **Durable Objects**: `EmployeeState` is addressed by
  `idFromName(`${tenantId}::${employeeName}`)` — distinct object per tenant.
- **Workflows**: `EmployeeCycle` params carry `tenantId` and fail closed if
  it's missing (an old pre-multitenancy instance errors out instead of
  silently running untenant-scoped).
- **Sandbox brain**: each tenant gets its own container
  (`dazl-brain-${tenantId}`) with its own Claude Code session — tenants never
  share a filesystem or agent context.
- **R2**: brain-repo snapshots moved from `brain-repo.tar.b64` to
  `tenants/${tenantId}/brain-repo.tar.b64`.
- **Cron**: the hourly wake iterates every tenant's roster and uses a
  deterministic per-hour instance id (`cron-<sha256(tenant, name, hour)>` —
  hashed because the Workflows runtime rejects ids containing `:`) so a
  re-run within the hour dedupes instead of double-billing cycles.

## Deploying the migration — CONTROLLED CUTOVER REQUIRED

`migrations/0002_multitenancy.sql` is data-preserving but NOT a
drop-in additive migration: `employees` is rebuilt with a new primary key,
and the old worker code (which never supplies `tenant_id`) cannot write to
the rebuilt table. Applying it while the old code still serves requests will
break them. Treat it as a breaking schema change:

1. Announce a brief maintenance window (minutes, not hours).
2. Let in-flight `EmployeeCycle` workflow instances finish or age out (old
   instances have no `tenantId` and will fail closed — that is intended; see
   the workflow guard). Draining first avoids noisy failures.
3. Apply the migration, then deploy the new code immediately:
   `npx wrangler d1 migrations apply <db> --remote && npx wrangler deploy`
   (one window; do not leave the migrated schema serving old code).

Cutover behavior:

1. **Employee goals are preserved.** Roster rows (including goals) and
   memories survive the migration, re-homed under the `default` tenant —
   covered by `test/cutover.test.ts`, which seeds a 0001 world and upgrades
   it in place. `getEffectiveGoal` hydrates the newly-named
   `default::<name>` Durable Objects from the preserved roster rows, so
   cycles keep researching each employee's real goal instead of silently
   falling back to the generic "grow dazl.ai".
2. **Orphaned legacy DOs** — pre-migration `EmployeeState` objects were
   named `employeeName`; they are now addressed as `default::employeeName`.
   Old objects simply stop receiving traffic; nothing reads them. No action
   required.
3. **Orphaned R2 snapshot** — a pre-migration `brain-repo.tar.b64` at the
   bucket root is not read anymore. If you want the default tenant to keep
   its history, copy it to `tenants/default/brain-repo.tar.b64`; otherwise
   the next cycle re-seeds from the baked-in seed.
4. **Legacy routes** keep working against the `default` tenant so existing
   scripts and `RUNTIME_VERIFY.md` flows don't break. Migrate them to `/v1`
   at leisure.

## Proxy routes (Swift app)

`/chat`, `/tts`, `/transcribe-token` are unchanged and still open, because the
shipped Mac app does not send an Authorization header on them. To close them:
set `PROXY_SHARED_SECRET` (`npx wrangler secret put PROXY_SHARED_SECRET`),
update the Swift clients to send `Authorization: Bearer <secret>`, and the
worker starts requiring it. Until then, leave it unset.

## Remaining gaps to "production-ready SaaS"

This milestone closes tenant isolation and credential handling. Still open,
roughly in priority order:

1. **Web dashboard** — no dazl.ai web app exists yet (the Mac companion is
   the only client). Needs tenant signup/login (Cloudflare Access or
   first-party auth), employee management UI, cycle output browsing.
2. **Billing/quota** — per-tenant usage metering (sandbox minutes, LLM
   tokens, workflow runs) and plan limits; today an admin-minted key has
   unlimited spend.
3. **Sandbox capacity AND same-tenant concurrency** — `max_instances = 1`
   on the Sandbox class in `src/index.ts` supports exactly one concurrent
   tenant brain. Real multi-tenant load needs a higher limit (costs scale
   with it). Separately: within one tenant, multiple employees/overlapping
   workflows still share that tenant's single sandbox workspace (hydrate →
   run → persist), so concurrent same-tenant cycles can interleave. Serialize
   per-tenant cycles or add safe persistence semantics before real load.
4. **Open paid proxy routes** — `/chat`, `/tts`, `/transcribe-token` remain
   unauthenticated for Swift-app compatibility; update the client to send
   auth and set `PROXY_SHARED_SECRET` before public production exposure.
5. **Real-container verification** — the test suite stubs the sandbox
   (containers are not enabled under vitest); a successful end-to-end cycle
   against a real container in a preview environment is still required
   before claiming operational readiness.
6. **Outbound channels** — Gojiberry/Gooseworks parity (email, LinkedIn,
   social publishing) is not started; the employee loop currently produces
   research lessons only.
7. **Observability** — structured logs/tenant tags in Sentry, per-tenant
   error budgets, alerting on failed cycles.
