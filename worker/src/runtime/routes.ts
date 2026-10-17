import type { Env } from "./env";
import { recallRecentMemories } from "./memory";
import { authenticateRequest, type RequestAuth } from "./auth";
import { createTenant, mintApiKey, revokeApiKey, tenantExists } from "./tenants";

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
  console.error(`[${routeLabel}] Unhandled error:`, error);
  return new Response(JSON.stringify({ error: String(error) }), {
    status: 500,
    headers: { "content-type": "application/json" },
  });
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
export function buildCronCycleInstanceId(tenantId: string, employeeName: string, nowMs: number): string {
  const hourBucket = Math.floor(nowMs / 3_600_000);
  return `cron:${tenantId}::${employeeName}:${hourBucket}`;
}

async function startEmployeeCycle(env: Env, tenantId: string, employeeName: string, instanceId?: string): Promise<void> {
  const createParams = { id: instanceId, params: { tenantId, employeeName } };
  await env.EMPLOYEE_CYCLE.create(createParams);
}

// POST /v1/tenants — provision a tenant. Admin-secret only: tenant
// provisioning must not be self-service, or an unauthenticated caller could
// mint credentials and consume sandbox/LLM budget. The first API key is
// returned in this response and never again.
export async function handleCreateTenant(request: Request, env: Env): Promise<Response> {
  const auth = await authenticateRequest(request, env);
  if (!auth?.isAdmin) return unauthorizedResponse();

  try {
    const body = await request.json<{ name?: unknown }>();
    if (typeof body.name !== "string" || body.name.trim().length === 0 || body.name.length > 200) {
      return new Response(JSON.stringify({ error: "name must be a non-empty string (max 200 chars)" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    const tenant = await createTenant(env.DB, body.name.trim());
    const firstKey = await mintApiKey(env.DB, tenant.tenantId);

    return Response.json({
      tenantId: tenant.tenantId,
      name: tenant.name,
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
    const body = await request.json<{ employeeName: string; role: string; goal: string; tenantId?: unknown }>();

    if (typeof body.employeeName !== "string" || !EMPLOYEE_NAME_PATTERN.test(body.employeeName)) {
      return invalidEmployeeNameResponse();
    }

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

    const stubId = employeeDurableObjectId(env, auth.tenantId, employeeName);
    const goal = await env.EMPLOYEE.get(stubId).getGoal();
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
    const stubId = employeeDurableObjectId(env, DEFAULT_TENANT_ID, employeeName);
    const goal = await env.EMPLOYEE.get(stubId).getGoal();
    const memories = await recallRecentMemories(env.DB, DEFAULT_TENANT_ID, employeeName, 20);
    return Response.json({ employeeName, goal, memories });
  } catch (error) {
    return errorResponse(`GET /employees/${employeeName}`, error);
  }
}

// Cron wake: start a cycle for every known employee of every tenant, with a
// deterministic per-hour instance id so a re-run inside the same hour is a
// no-op rather than a duplicate billed cycle. Not guarded by auth — this
// path is triggered internally by Cloudflare's cron scheduler, not by an
// externally reachable HTTP request.
export async function wakeAllEmployees(env: Env): Promise<void> {
  const result = await env.DB.prepare(
    "SELECT tenant_id, employee_name FROM employees"
  ).all<{ tenant_id: string; employee_name: string }>();

  for (const row of result.results) {
    const instanceId = buildCronCycleInstanceId(row.tenant_id, row.employee_name, Date.now());
    try {
      await startEmployeeCycle(env, row.tenant_id, row.employee_name, instanceId);
    } catch (error) {
      // Cloudflare Workflows rejects a create() whose instance id already
      // exists — that is the dedupe working, not a failure. Only genuinely
      // unexpected errors should be (and are) logged.
      const errorMessage = String(error);
      const isDuplicateInstanceError = errorMessage.includes("already exists");
      if (isDuplicateInstanceError) continue;
      // One employee failing to wake should not abort waking the rest of
      // the roster.
      console.error(
        `[wakeAllEmployees] Failed to start cycle for "${row.tenant_id}::${row.employee_name}":`,
        error
      );
    }
  }
}
