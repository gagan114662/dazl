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
  deterministic per-hour instance id (`cron:<tenant>::<name>:<hourBucket>`) so
  a re-run within the hour dedupes instead of double-billing cycles.

## Deploying the migration

`migrations/0002_multitenancy.sql` is additive: existing employees/memory are
re-homed under the `default` tenant and nothing is dropped.

```
npx wrangler d1 migrations apply dazl-main-db --remote   # adjust binding/env as needed
```

Cutover notes:

1. **Orphaned legacy DOs** — pre-migration `EmployeeState` objects were named
   `employeeName`; they are now addressed as `default::employeeName`. Old
   objects simply stop receiving traffic (goals are re-set on the next spawn;
   nothing reads the old instances). No action required.
2. **Orphaned R2 snapshot** — a pre-migration `brain-repo.tar.b64` at the
   bucket root is not read anymore. If you want the default tenant to keep
   its history, copy it to `tenants/default/brain-repo.tar.b64`; otherwise
   the next cycle re-seeds from the baked-in seed.
3. **Legacy routes** keep working against the `default` tenant so existing
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
3. **Sandbox capacity** — `max_instances = 1` on the Sandbox class in
   `src/index.ts` supports exactly one concurrent tenant brain. Real
   multi-tenant load needs a higher limit (costs scale with it).
4. **Outbound channels** — Gojiberry/Gooseworks parity (email, LinkedIn,
   social publishing) is not started; the employee loop currently produces
   research lessons only.
5. **Observability** — structured logs/tenant tags in Sentry, per-tenant
   error budgets, alerting on failed cycles.
