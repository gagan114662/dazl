import type { Env } from "./env";
import { recallRecentMemories } from "./memory";
import { getEffectiveGoal } from "./cycle";
import { authenticateRequest, type RequestAuth } from "./auth";
import { createTenant, mintApiKey, revokeApiKey, tenantExists } from "./tenants";
import { checkQuota, getTenantPlan, PLAN_LIMITS, QuotaError, quotaExceededResponse, recordUsage, reserveUsage } from "./plans";
import { logEvent } from "./log";

// The plan's identity convention for employee names: lowercase kebab-case.
// Shared by spawn validation and the route path matchers so routes and
// validation accept/reject the same charset.
const EMPLOYEE_NAME_PATTERN = /^[a-z0-9-]+$/;

// The tenant every pre-multitenancy (single-tenant) row was re-homed under
// by migrations/0002_multitenancy.sql. The legacy DAZL_API_SECRET-guarded
// routes operate on it and are deprecated in favor of /v1.
export const DEFAULT_TENANT_ID = "default";

// Shared-secret guard for the legacy (pre-multitenancy, default-tenant)
// employee HTTP routes. Superseded for tenant traffic by authenticateRequest;
// kept because the Swift app and RUNTIME_VERIFY.md flows still use it.
export function isAuthorized(request: Request, env: Env): boolean {
  // If DAZL_API_SECRET is unset/empty, `Bearer ${env.DAZL_API_SECRET}` would
  // evaluate to `Bearer undefined` (or `Bearer `), which an attacker could
  // send verbatim to bypass auth. Deny outright whenever no real secret is
  // configured, before ever comparing headers.
  if (!env.DAZL_API_SECRET) return false;

  const authorizationHeader = request.headers.get("Authorization");
  if (!authorizationHeader) return false;
  const expectedHeader = `Bearer ${env.DAZL_API_SECRET}`;
  return authorizationHeader === expectedHeader;
}

function unauthorizedResponse(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

function notFoundResponse(message = "not found"): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(routeLabel: string, error: unknown): Response {
  if (error instanceof QuotaError) return error.toResponse();
  // Full details go to the logs only — echoing String(error) to the caller
  // can leak internals (SQL fragments, binding names) and is a 500 smell.
  logEvent("error", "unhandled_route_error", { route: routeLabel, error: String(error) });
  return new Response(JSON.stringify({ error: "internal error" }), {
    status: 500,
    headers: { "content-type": "application/json" },
  });
}

function invalidRequestResponse(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}

// Parse a JSON request body, mapping malformed JSON to a 400 instead of the
// 500 an unhandled parse exception would produce.
async function parseJsonBody<T>(request: Request): Promise<T | null> {
  try {
    return await request.json<T>();
  } catch {
    return null;
  }
}

function invalidEmployeeNameResponse(): Response {
  return new Response(
    JSON.stringify({ error: "employeeName must be a non-empty lowercase-kebab string" }),
    {
      status: 400,
      headers: { "content-type": "application/json" },
    }
  );
}

// Every EmployeeState Durable Object is namespaced by tenant: the composite
// name `${tenantId}::${employeeName}` means two tenants hiring "researcher"
// resolve to two distinct objects. The `::` separator is unambiguous because
// tenant ids (`t_<hex>`) and employee names (kebab-case) can never contain
// it. (Legacy single-tenant DOs named just `employeeName` are orphaned by
// this change — see MULTITENANCY.md's migration notes.)
function employeeDurableObjectId(env: Env, tenantId: string, employeeName: string) {
  return env.EMPLOYEE.idFromName(`${tenantId}::${employeeName}`);
}

// Deterministic per-hour instance id for cron-started cycles: re-running the
// hourly cron within the same clock hour resolves to the same id, and
// Cloudflare Workflows rejects a duplicate instance id, so the second create
// is a no-op instead of a second billed cycle. Explicit spawns (POST /v1/employees)
// intentionally do NOT use this — a human asking twice should get two cycles.
//
// The id is a SHA-256 hex digest of the (tenant, employee, hour) tuple, not
// the raw tuple: Workflows rejects ids containing `:` (verified empirically
// — "Workflow instance has invalid id"), and hashing also bounds the id
// length and charset regardless of how long tenant/employee names are.
export async function buildCronCycleInstanceId(
  tenantId: string,
  employeeName: string,
  nowMs: number
): Promise<string> {
  const hourBucket = Math.floor(nowMs / 3_600_000);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${tenantId}::${employeeName}:${hourBucket}`)
  );
  const digestHex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `cron-${digestHex}`;
}

async function startEmployeeCycle(env: Env, tenantId: string, employeeName: string, instanceId?: string): Promise<void> {
  const createParams = { id: instanceId, params: { tenantId, employeeName } };
  // Reserve the cycle atomically BEFORE creating it so concurrent starts
  // cannot overshoot the plan; refund if the create fails.
  const reservation = await reserveUsage(env.DB, tenantId, "cycle");
  if (!reservation.reserved) throw new QuotaError("cycle", reservation);
  try {
    await env.EMPLOYEE_CYCLE.create(createParams);
  } catch (error) {
    await recordUsage(env.DB, tenantId, "cycle", -1);
    throw error;
  }
}

// POST /v1/tenants — provision a tenant. Admin-secret only: tenant
// provisioning must not be self-service, or an unauthenticated caller could
// mint credentials and consume sandbox/LLM budget. The first API key is
// returned in this response and never again.
export async function handleCreateTenant(request: Request, env: Env): Promise<Response> {
  const auth = await authenticateRequest(request, env);
  if (!auth?.isAdmin) return unauthorizedResponse();

  try {
    const body = await parseJsonBody<{ name?: unknown }>(request);
    if (body === null) return invalidRequestResponse("request body must be valid JSON");
    if (typeof body.name !== "string" || body.name.trim().length === 0 || body.name.length > 200) {
      return invalidRequestResponse("name must be a non-empty string (max 200 chars)");
    }

    const tenant = await createTenant(env.DB, body.name.trim());
    const firstKey = await mintApiKey(env.DB, tenant.tenantId);

    return Response.json({
      tenantId: tenant.tenantId,
      name: tenant.name,
      keyId: firstKey.keyId,
      apiKey: firstKey.apiKey,
      note: "This apiKey is shown once. Store it now — only its SHA-256 digest is persisted.",
    });
  } catch (error) {
    return errorResponse("POST /v1/tenants", error);
  }
}

// POST /v1/tenants/:tenantId/api-keys — mint an additional key for a tenant.
// Admin-secret only (revoking/minting is an operator action; tenant keys
// themselves are for the employee API).
export async function handleMintTenantKey(request: Request, env: Env, tenantId: string): Promise<Response> {
  const auth = await authenticateRequest(request, env);
  if (!auth?.isAdmin) return unauthorizedResponse();

  try {
    if (!(await tenantExists(env.DB, tenantId))) return notFoundResponse("unknown tenant");

    const issuance = await mintApiKey(env.DB, tenantId);
    return Response.json({
      keyId: issuance.keyId,
      apiKey: issuance.apiKey,
      note: "This apiKey is shown once. Store it now — only its SHA-256 digest is persisted.",
    });
  } catch (error) {
    return errorResponse(`POST /v1/tenants/${tenantId}/api-keys`, error);
  }
}

// DELETE /v1/api-keys/:keyId — revoke a key.
export async function handleRevokeKey(request: Request, env: Env, keyId: string): Promise<Response> {
  const auth = await authenticateRequest(request, env);
  if (!auth?.isAdmin) return unauthorizedResponse();

  try {
    const revoked = await revokeApiKey(env.DB, keyId);
    if (!revoked) return notFoundResponse("unknown or already-revoked key");
    return Response.json({ revoked: true, keyId });
  } catch (error) {
    return errorResponse(`DELETE /v1/api-keys/${keyId}`, error);
  }
}

// POST /v1/employees — hire/assign an employee and start its first cycle.
// The tenant comes from the API key, never from the body: a forged
// body-level tenantId is ignored (read, not used).
export async function handleSpawnEmployeeV1(request: Request, env: Env, auth: RequestAuth): Promise<Response> {
  // Tenant-scoped route: admin credentials carry no tenant and are rejected
  // rather than guessing a default tenant.
  if (auth.tenantId === null) return unauthorizedResponse();

  try {
    const body = await parseJsonBody<{
      employeeName: string;
      role: string;
      goal: string;
      tenantId?: unknown;
    }>(request);

    if (body === null) return invalidRequestResponse("request body must be valid JSON");
    if (
      typeof body.employeeName !== "string" ||
      body.employeeName.length > 64 ||
      !EMPLOYEE_NAME_PATTERN.test(body.employeeName)
    ) {
      return invalidEmployeeNameResponse();
    }
    if (typeof body.role !== "string" || body.role.length === 0 || body.role.length > 200) {
      return invalidRequestResponse("role must be a non-empty string (max 200 chars)");
    }
    if (typeof body.goal !== "string" || body.goal.length === 0 || body.goal.length > 2000) {
      return invalidRequestResponse("goal must be a non-empty string (max 2000 chars)");
    }

    // Plan quotas: a NEW employee counts against the plan's headcount cap
    // (re-goaling an existing one does not), and every spawn starts a cycle.
    const existingEmployee = await env.DB.prepare(
      "SELECT 1 AS x FROM employees WHERE tenant_id = ? AND employee_name = ?"
    ).bind(auth.tenantId, body.employeeName).first();
    if (existingEmployee === null) {
      const plan = await getTenantPlan(env.DB, auth.tenantId);
      const headcount = await env.DB.prepare("SELECT COUNT(*) AS n FROM employees WHERE tenant_id = ?")
        .bind(auth.tenantId).first<{ n: number }>();
      const limit = PLAN_LIMITS[plan].maxEmployees;
      if ((headcount?.n ?? 0) >= limit) {
        return quotaExceededResponse("employees", { allowed: false, used: headcount?.n ?? 0, limit, plan });
      }
    }
    const cycleQuota = await checkQuota(env.DB, auth.tenantId, "cycle");
    if (!cycleQuota.allowed) return quotaExceededResponse("cycle", cycleQuota);

    // Insert the D1 roster row FIRST: it is the source of truth the cron
    // wake path reads, so an employee must be visible there before the DO
    // holds a goal for it or a cycle is scheduled — otherwise a crash
    // between these steps could leave a DO with a goal but no roster entry.
    await env.DB.prepare(
      "INSERT INTO employees (tenant_id, employee_name, role, goal) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(tenant_id, employee_name) DO UPDATE SET role = excluded.role, goal = excluded.goal"
    ).bind(auth.tenantId, body.employeeName, body.role, body.goal).run();

    const stubId = employeeDurableObjectId(env, auth.tenantId, body.employeeName);
    await env.EMPLOYEE.get(stubId).setGoal(body.goal);

    await startEmployeeCycle(env, auth.tenantId, body.employeeName);

    return Response.json({ started: true, tenantId: auth.tenantId, employeeName: body.employeeName });
  } catch (error) {
    return errorResponse("POST /v1/employees", error);
  }
}

// GET /v1/employees — list the calling tenant's roster (only that tenant's).
export async function handleListEmployeesV1(env: Env, auth: RequestAuth): Promise<Response> {
  if (auth.tenantId === null) return unauthorizedResponse();

  try {
    const result = await env.DB.prepare(
      "SELECT employee_name, role, goal, created_at FROM employees WHERE tenant_id = ? ORDER BY created_at"
    ).bind(auth.tenantId).all<{ employee_name: string; role: string; goal: string | null; created_at: number }>();

    return Response.json({
      tenantId: auth.tenantId,
      employees: result.results.map((row) => ({
        employeeName: row.employee_name,
        role: row.role,
        goal: row.goal,
        createdAt: row.created_at,
      })),
    });
  } catch (error) {
    return errorResponse("GET /v1/employees", error);
  }
}

// GET /v1/employees/:employeeName — inspect goal + recent memories. A 404
// (not 403) when the employee belongs to a different tenant: existence of
// another tenant's employee name is itself information not to leak.
export async function handleInspectEmployeeV1(employeeName: string, env: Env, auth: RequestAuth): Promise<Response> {
  if (auth.tenantId === null) return unauthorizedResponse();

  try {
    const rosterRow = await env.DB.prepare(
      "SELECT employee_name FROM employees WHERE tenant_id = ? AND employee_name = ?"
    ).bind(auth.tenantId, employeeName).first<{ employee_name: string }>();
    if (rosterRow === null) return notFoundResponse("unknown employee");

    const goal = await getEffectiveGoal(env, auth.tenantId, employeeName);
    const memories = await recallRecentMemories(env.DB, auth.tenantId, employeeName, 20);
    return Response.json({ tenantId: auth.tenantId, employeeName, goal, memories });
  } catch (error) {
    return errorResponse(`GET /v1/employees/${employeeName}`, error);
  }
}

// POST /employees — LEGACY default-tenant spawn (deprecated; see /v1). Kept
// working so existing operator scripts and RUNTIME_VERIFY.md flows keep
// functioning. Same body and behavior as before, scoped to DEFAULT_TENANT_ID.
export async function handleSpawnEmployee(request: Request, env: Env): Promise<Response> {
  if (!isAuthorized(request, env)) return unauthorizedResponse();

  try {
    const body = await request.json<{ employeeName: string; role: string; goal: string }>();

    if (typeof body.employeeName !== "string" || !EMPLOYEE_NAME_PATTERN.test(body.employeeName)) {
      return invalidEmployeeNameResponse();
    }

    await env.DB.prepare(
      "INSERT INTO employees (tenant_id, employee_name, role, goal) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(tenant_id, employee_name) DO UPDATE SET role = excluded.role, goal = excluded.goal"
    ).bind(DEFAULT_TENANT_ID, body.employeeName, body.role, body.goal).run();

    const stubId = employeeDurableObjectId(env, DEFAULT_TENANT_ID, body.employeeName);
    await env.EMPLOYEE.get(stubId).setGoal(body.goal);

    await startEmployeeCycle(env, DEFAULT_TENANT_ID, body.employeeName);

    return Response.json({ started: true });
  } catch (error) {
    return errorResponse("POST /employees", error);
  }
}

// GET /employees/:employeeName — LEGACY default-tenant inspect (deprecated; see /v1).
export async function handleInspectEmployee(employeeName: string, env: Env, request: Request): Promise<Response> {
  if (!isAuthorized(request, env)) return unauthorizedResponse();

  try {
    // getEffectiveGoal (not a bare DO read) so a legacy employee whose goal
    // lives only in the D1 roster row is hydrated and reported correctly.
    const goal = await getEffectiveGoal(env, DEFAULT_TENANT_ID, employeeName);
    const memories = await recallRecentMemories(env.DB, DEFAULT_TENANT_ID, employeeName, 20);
    return Response.json({ employeeName, goal, memories });
  } catch (error) {
    return errorResponse(`GET /employees/${employeeName}`, error);
  }
}

// Cron wake: start a cycle for every known employee of every tenant.
// Not guarded by auth — this path is triggered internally by Cloudflare's cron
// scheduler, not by an externally reachable HTTP request.
//
// DEDUPE: a re-run within the same clock hour must not start a second billed
// cycle per employee. Relying on the Workflows runtime to reject a duplicate
// instance id does NOT work — verified empirically, a second create() with
// the same id neither throws nor is observably a no-op — so the once-per-hour
// claim lives in the cycle_runs D1 table: INSERT OR IGNORE makes exactly one
// concurrent caller the claimer, and everyone else skips.
export async function wakeAllEmployees(env: Env): Promise<void> {
  const result = await env.DB.prepare(
    "SELECT tenant_id, employee_name FROM employees"
  ).all<{ tenant_id: string; employee_name: string }>();

  for (const row of result.results) {
    // Over-quota tenants are skipped (no claim, no billed cycle); they resume
    // automatically when the month rolls over or the plan is upgraded.
    const cycleQuota = await checkQuota(env.DB, row.tenant_id, "cycle");
    if (!cycleQuota.allowed) {
      logEvent("warn", "cycle_skipped_over_quota", { tenantId: row.tenant_id, employeeName: row.employee_name, used: cycleQuota.used, limit: cycleQuota.limit });
      continue;
    }
    const hourBucket = Math.floor(Date.now() / 3_600_000);
    const claim = await env.DB.prepare(
      "INSERT OR IGNORE INTO cycle_runs (tenant_id, employee_name, hour_bucket) VALUES (?, ?, ?)"
    ).bind(row.tenant_id, row.employee_name, hourBucket).run();

    if (claim.meta.changes === 0) {
      // This employee already has its cycle for this hour (a previous wake,
      // or a concurrent wake that claimed it first). Skip.
      continue;
    }

    const instanceId = await buildCronCycleInstanceId(row.tenant_id, row.employee_name, Date.now());
    try {
      await startEmployeeCycle(env, row.tenant_id, row.employee_name, instanceId);
    } catch (error) {
      // The create failed AFTER the claim was recorded — delete the claim so
      // the next wake (or a manual re-run) retries instead of losing this
      // employee's hour entirely.
      await env.DB.prepare(
        "DELETE FROM cycle_runs WHERE tenant_id = ? AND employee_name = ? AND hour_bucket = ?"
      ).bind(row.tenant_id, row.employee_name, hourBucket).run();

      // One employee failing to wake should not abort waking the rest of
      // the roster.
      logEvent("error", "cron_cycle_start_failed", { tenantId: row.tenant_id, employeeName: row.employee_name, claimRolledBack: true, error: String(error) });
    }
  }
}
