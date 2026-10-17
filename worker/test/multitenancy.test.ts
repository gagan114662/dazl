import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { applyMigrations } from "./helpers/apply-migrations";
import worker from "../src/index";
import { buildCronCycleInstanceId } from "../src/runtime/routes";

const ADMIN_SECRET = "Bearer test-secret";

async function fetchWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function createTenant(name: string): Promise<{ tenantId: string; apiKey: string }> {
  const response = await fetchWorker(
    new Request("https://x/v1/tenants", {
      method: "POST",
      headers: { Authorization: ADMIN_SECRET },
      body: JSON.stringify({ name }),
    })
  );
  expect(response.status).toBe(200);
  return response.json<{ tenantId: string; apiKey: string }>();
}

async function spawnEmployee(apiKey: string, employeeName: string, goal: string, extraBody: object = {}): Promise<Response> {
  return fetchWorker(
    new Request("https://x/v1/employees", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ employeeName, role: "Analyst", goal, ...extraBody }),
    })
  );
}

describe("multitenancy", () => {
  beforeAll(async () => {
    await applyMigrations(env.DB);
  });

  it("provisions tenants with the admin secret and returns a one-time API key whose digest — not the key — is stored", async () => {
    const { tenantId, apiKey } = await createTenant("digest-check");

    expect(tenantId).toMatch(/^t_[0-9a-f]{16}$/);
    expect(apiKey).toMatch(/^dazl_[A-Za-z0-9_-]+$/);

    // Only the SHA-256 digest is persisted; a DB read must not contain the key.
    const keyRow = await env.DB.prepare(
      "SELECT key_digest FROM api_keys WHERE tenant_id = ?"
    ).bind(tenantId).first<{ key_digest: string }>();
    expect(keyRow).not.toBeNull();
    expect(keyRow!.key_digest).not.toContain(apiKey);
    expect(keyRow!.key_digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects tenant provisioning without the admin secret (no self-service signup)", async () => {
    const response = await fetchWorker(
      new Request("https://x/v1/tenants", {
        method: "POST",
        headers: { Authorization: "Bearer dazl_someonesguessedkey" },
        body: JSON.stringify({ name: "attacker" }),
      })
    );
    expect(response.status).toBe(401);
  });

  it("isolates two tenants that hire identically-named employees (goal, memory, roster)", async () => {
    const tenantA = await createTenant("tenant-a");
    const tenantB = await createTenant("tenant-b");

    const spawnA = await spawnEmployee(tenantA.apiKey, "researcher", "grow tenant A's podcast");
    const spawnB = await spawnEmployee(tenantB.apiKey, "researcher", "grow tenant B's newsletter");
    expect(spawnA.status).toBe(200);
    expect(spawnB.status).toBe(200);

    const inspectA = await fetchWorker(
      new Request("https://x/v1/employees/researcher", {
        headers: { Authorization: `Bearer ${tenantA.apiKey}` },
      })
    );
    const inspectB = await fetchWorker(
      new Request("https://x/v1/employees/researcher", {
        headers: { Authorization: `Bearer ${tenantB.apiKey}` },
      })
    );
    expect(inspectA.status).toBe(200);
    expect(inspectB.status).toBe(200);

    const dataA = await inspectA.json<{ goal: string; tenantId: string }>();
    const dataB = await inspectB.json<{ goal: string; tenantId: string }>();
    expect(dataA.goal).toBe("grow tenant A's podcast");
    expect(dataB.goal).toBe("grow tenant B's newsletter");
    expect(dataA.tenantId).toBe(tenantA.tenantId);
    expect(dataB.tenantId).toBe(tenantB.tenantId);

    // The list route returns ONLY the calling tenant's roster.
    const listA = await fetchWorker(
      new Request("https://x/v1/employees", { headers: { Authorization: `Bearer ${tenantA.apiKey}` } })
    );
    const listDataA = await listA.json<{ employees: { employeeName: string }[] }>();
    expect(listDataA.employees.map((e) => e.employeeName)).toContain("researcher");

    // Same employee name, same table — but different tenant_id rows.
    const rosterRows = await env.DB.prepare(
      "SELECT tenant_id, employee_name, goal FROM employees WHERE employee_name = ?"
    ).bind("researcher").all<{ tenant_id: string; goal: string }>();
    expect(rosterRows.results.length).toBeGreaterThanOrEqual(2);
  });

  it("returns 404 when a tenant asks for another tenant's employee name (existence not leaked)", async () => {
    const tenantA = await createTenant("iso-a");
    const tenantB = await createTenant("iso-b");
    await spawnEmployee(tenantB.apiKey, "b-only-writer", "tenant B's writer");

    const response = await fetchWorker(
      new Request("https://x/v1/employees/b-only-writer", {
        headers: { Authorization: `Bearer ${tenantA.apiKey}` },
      })
    );
    expect(response.status).toBe(404);
  });

  it("ignores a forged tenantId in the request body — the tenant comes from the API key", async () => {
    const tenantA = await createTenant("forge-a");
    const tenantB = await createTenant("forge-b");

    const spawn = await spawnEmployee(tenantA.apiKey, "forged-name", "tenant A goal", {
      tenantId: tenantB.tenantId,
    });
    expect(spawn.status).toBe(200);

    const row = await env.DB.prepare(
      "SELECT tenant_id FROM employees WHERE employee_name = ?"
    ).bind("forged-name").first<{ tenant_id: string }>();
    expect(row?.tenant_id).toBe(tenantA.tenantId);
  });

  it("rejects a revoked API key", async () => {
    const tenant = await createTenant("revoke-check");
    const keyRow = await env.DB.prepare(
      "SELECT key_id FROM api_keys WHERE tenant_id = ?"
    ).bind(tenant.tenantId).first<{ key_id: string }>();

    const revoke = await fetchWorker(
      new Request(`https://x/v1/api-keys/${keyRow!.key_id}`, {
        method: "DELETE",
        headers: { Authorization: ADMIN_SECRET },
      })
    );
    expect(revoke.status).toBe(200);

    const response = await fetchWorker(
      new Request("https://x/v1/employees", { headers: { Authorization: `Bearer ${tenant.apiKey}` } })
    );
    expect(response.status).toBe(401);
  });

  it("rejects tenant-key use of admin-only routes and admin use of tenant routes", async () => {
    const tenant = await createTenant("role-check");

    // Tenant key cannot provision tenants.
    const tenantProvision = await fetchWorker(
      new Request("https://x/v1/tenants", {
        method: "POST",
        headers: { Authorization: `Bearer ${tenant.apiKey}` },
        body: JSON.stringify({ name: "nope" }),
      })
    );
    expect(tenantProvision.status).toBe(401);

    // Admin secret has no tenant scope, so tenant-scoped routes reject it.
    const adminSpawn = await fetchWorker(
      new Request("https://x/v1/employees", {
        method: "POST",
        headers: { Authorization: ADMIN_SECRET },
        body: JSON.stringify({ employeeName: "admin-hire", role: "Analyst", goal: "x" }),
      })
    );
    expect(adminSpawn.status).toBe(401);
  });

  it("keeps the legacy default-tenant routes working with the admin secret", async () => {
    const spawn = await fetchWorker(
      new Request("https://x/employees", {
        method: "POST",
        headers: { Authorization: ADMIN_SECRET },
        body: JSON.stringify({ employeeName: "legacy-writer", role: "Writer", goal: "legacy goal" }),
      })
    );
    expect(spawn.status).toBe(200);

    const inspect = await fetchWorker(
      new Request("https://x/employees/legacy-writer", { headers: { Authorization: ADMIN_SECRET } })
    );
    expect(inspect.status).toBe(200);
    const data = await inspect.json<{ goal: string }>();
    expect(data.goal).toBe("legacy goal");

    // The legacy route wrote to the default tenant, not a new one.
    const row = await env.DB.prepare(
      "SELECT tenant_id FROM employees WHERE employee_name = ?"
    ).bind("legacy-writer").first<{ tenant_id: string }>();
    expect(row?.tenant_id).toBe("default");
  });

  it("builds deterministic per-hour cron instance ids so an hourly re-run dedupes instead of double-billing", () => {
    const hourMs = 3_600_000;
    const now = 1_780_000_000_000;

    const firstRun = buildCronCycleInstanceId("t_abc", "researcher", now);
    const sameHourAgain = buildCronCycleInstanceId("t_abc", "researcher", now + 10 * 60 * 1000);
    const nextHour = buildCronCycleInstanceId("t_abc", "researcher", now + hourMs);
    const otherTenant = buildCronCycleInstanceId("t_def", "researcher", now);

    expect(firstRun).toBe(sameHourAgain);
    expect(firstRun).not.toBe(nextHour);
    expect(firstRun).not.toBe(otherTenant);
  });
});
