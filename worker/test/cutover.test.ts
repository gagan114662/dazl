import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { applyMigrations } from "./helpers/apply-migrations";
import { getEffectiveGoal } from "../src/runtime/cycle";

// Simulates the production cutover this migration must survive: a live
// single-tenant deployment (0001 schema) with real employees, goals, and
// memories, upgraded in place by 0002. Asserts nothing is lost and that the
// new tenant-scoped code paths pick up the pre-existing data.
//
// The preservation test runs on a DEDICATED test-only database (CUTOVER_DB):
// it must start from the 0001 schema, which is impossible on the shared
// env.DB where parallel test files apply 0002 first.
describe("multitenancy cutover (0001 -> 0002)", () => {
  beforeAll(async () => {
    // Ensure the shared DB (used by the hydration test below) is migrated.
    await applyMigrations(env.DB);
  });

  it("preserves employees, goals, and memories when 0002 re-homes them under the default tenant", async () => {
    const cutoverDb = (env as unknown as { CUTOVER_DB: D1Database }).CUTOVER_DB;

    // Build the pre-migration world first: 0001 only.
    await applyMigrations(cutoverDb, ["0001_init.sql"]);

    // A pre-existing employee with a goal, plus its memories.
    await cutoverDb.prepare(
      "INSERT INTO employees (employee_name, role, goal) VALUES ('legacy-analyst', 'Analyst', 'pre-migration goal')"
    ).run();
    await cutoverDb.prepare(
      "INSERT INTO memory (employee_name, kind, content) VALUES " +
        "('legacy-analyst', 'fact', 'pre-migration fact'), " +
        "('legacy-analyst', 'lesson', 'pre-migration lesson')"
    ).run();

    // Now apply the multitenancy migration on top of the live data.
    await applyMigrations(cutoverDb, ["0002_multitenancy.sql"]);

    // The employee row survived, re-homed under the default tenant, goal intact.
    const employeeRow = await cutoverDb.prepare(
      "SELECT tenant_id, role, goal FROM employees WHERE employee_name = ?"
    ).bind("legacy-analyst").first<{ tenant_id: string; role: string; goal: string | null }>();
    expect(employeeRow).not.toBeNull();
    expect(employeeRow!.tenant_id).toBe("default");
    expect(employeeRow!.role).toBe("Analyst");
    expect(employeeRow!.goal).toBe("pre-migration goal");

    // The memories survived and were re-homed too.
    const memoryRows = await cutoverDb.prepare(
      "SELECT tenant_id, kind, content FROM memory WHERE employee_name = ? ORDER BY content"
    ).bind("legacy-analyst").all<{ tenant_id: string; kind: string; content: string }>();
    expect(memoryRows.results.map((row) => row.content)).toEqual([
      "pre-migration fact",
      "pre-migration lesson",
    ]);
    for (const row of memoryRows.results) {
      expect(row.tenant_id).toBe("default");
    }

    // The default tenant row exists for the legacy routes to scope against.
    const tenantRow = await cutoverDb.prepare(
      "SELECT name FROM tenants WHERE tenant_id = 'default'"
    ).first<{ name: string }>();
    expect(tenantRow?.name).toBe("Default (pre-multitenancy)");
  });

  it("hydrates the newly-named DO from the preserved roster goal so cycles don't fall back to the generic goal", async () => {
    // After cutover, DOs are addressed as `default::legacy-analyst` — a NEW
    // object with no goal set. getEffectiveGoal must fall back to the D1
    // roster row, hydrate the DO, and return the pre-migration goal.
    // (Uses the shared DB, which is already on the 0002 schema.)
    await env.DB.prepare(
      "INSERT INTO employees (tenant_id, employee_name, role, goal) VALUES " +
        "('default', 'hydration-analyst', 'Analyst', 'roster-only goal') " +
        "ON CONFLICT(tenant_id, employee_name) DO UPDATE SET goal = excluded.goal"
    ).run();

    const goal = await getEffectiveGoal(env as never, "default", "hydration-analyst");
    expect(goal).toBe("roster-only goal");

    // And the hydration persisted — a bare DO read now returns it too.
    const stubId = env.EMPLOYEE.idFromName("default::hydration-analyst");
    expect(await env.EMPLOYEE.get(stubId).getGoal()).toBe("roster-only goal");
  });
});
