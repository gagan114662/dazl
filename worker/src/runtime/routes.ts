import type { Env } from "./env";
import { recallRecentMemories } from "./memory";

// The plan's identity convention for employee names: lowercase kebab-case.
// Shared by spawn validation and the index.ts inspect-route path matcher so
// both routes accept/reject the same charset.
const EMPLOYEE_NAME_PATTERN = /^[a-z0-9-]+$/;

// Shared-secret guard for the externally reachable employee HTTP routes.
// Requires `Authorization: Bearer <DAZL_API_SECRET>`. Not applied to the
// scheduled/cron path, which Cloudflare triggers internally and is not
// externally reachable.
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

// POST /employees — hire/assign an employee and start its first cycle.
export async function handleSpawnEmployee(request: Request, env: Env): Promise<Response> {
  if (!isAuthorized(request, env)) return unauthorizedResponse();

  try {
    const body = await request.json<{ employeeName: string; role: string; goal: string }>();

    if (typeof body.employeeName !== "string" || !EMPLOYEE_NAME_PATTERN.test(body.employeeName)) {
      return invalidEmployeeNameResponse();
    }

    // Insert the D1 roster row FIRST: it is the source of truth the cron
    // wake path reads, so an employee must be visible there before the DO
    // holds a goal for it or a cycle is scheduled — otherwise a crash
    // between these steps could leave a DO with a goal but no roster entry.
    await env.DB.prepare(
      "INSERT INTO employees (employee_name, role, goal) VALUES (?, ?, ?) " +
        "ON CONFLICT(employee_name) DO UPDATE SET role = excluded.role, goal = excluded.goal"
    ).bind(body.employeeName, body.role, body.goal).run();

    const stubId = env.EMPLOYEE.idFromName(body.employeeName);
    await env.EMPLOYEE.get(stubId).setGoal(body.goal);

    await env.EMPLOYEE_CYCLE.create({ params: { employeeName: body.employeeName } });

    return Response.json({ started: true });
  } catch (error) {
    return errorResponse("POST /employees", error);
  }
}

// GET /employees/:employeeName — inspect goal + recent memories.
export async function handleInspectEmployee(employeeName: string, env: Env, request: Request): Promise<Response> {
  if (!isAuthorized(request, env)) return unauthorizedResponse();

  try {
    const stubId = env.EMPLOYEE.idFromName(employeeName);
    const goal = await env.EMPLOYEE.get(stubId).getGoal();
    const memories = await recallRecentMemories(env.DB, employeeName, 20);
    return Response.json({ employeeName, goal, memories });
  } catch (error) {
    return errorResponse(`GET /employees/${employeeName}`, error);
  }
}

// Cron wake: start a cycle for every known employee. Not guarded by
// isAuthorized — this path is triggered internally by Cloudflare's cron
// scheduler, not by an externally reachable HTTP request.
export async function wakeAllEmployees(env: Env): Promise<void> {
  const result = await env.DB.prepare("SELECT employee_name FROM employees").all<{
    employee_name: string;
  }>();
  for (const row of result.results) {
    try {
      await env.EMPLOYEE_CYCLE.create({ params: { employeeName: row.employee_name } });
    } catch (error) {
      // One employee failing to wake should not abort waking the rest of
      // the roster.
      console.error(`[wakeAllEmployees] Failed to start cycle for "${row.employee_name}":`, error);
    }
  }
}
