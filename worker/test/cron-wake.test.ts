import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { applyMigrations } from "./helpers/apply-migrations";
import { wakeAllEmployees, buildCronCycleInstanceId } from "../src/runtime/routes";

interface RecordedCreate {
  id?: string;
  params: { tenantId: string; employeeName: string };
}

// Exercises the ACTUAL cron path: wakeAllEmployees must attempt a Workflow
// create for every tenant's employees, with tenant-correct params and the
// deterministic per-hour id, and must swallow the duplicate-create rejection
// on a re-run within the same hour instead of double-billing.
//
// The EMPLOYEE_CYCLE binding is replaced with a recording fake: the real
// binding's stub cannot be wrapped in a plain object (it fails with
// "ServiceStub cannot be serialized"), and runtime acceptance of the id
// format is proven separately by the test below.
describe("cron wake (wakeAllEmployees)", () => {
  beforeAll(async () => {
    await applyMigrations(env.DB);
  });

  it("creates one workflow per employee with tenant-correct params, and dedupes re-runs within the hour", async () => {
    // Two tenants, each with roster rows — inserted directly so no spawn
    // route runs first (the spawn path creates its own random-id instance
    // and would muddy the count).
    await env.DB.prepare(
      "INSERT INTO tenants (tenant_id, name) VALUES ('t_wake_a', 'wake a'), ('t_wake_b', 'wake b') " +
        "ON CONFLICT(tenant_id) DO NOTHING"
    ).run();
    await env.DB.prepare(
      "INSERT INTO employees (tenant_id, employee_name, role, goal) VALUES " +
        "('t_wake_a', 'researcher', 'Analyst', 'goal a'), " +
        "('t_wake_b', 'researcher', 'Analyst', 'goal b'), " +
        "('t_wake_b', 'writer', 'Writer', 'goal c') " +
        "ON CONFLICT(tenant_id, employee_name) DO NOTHING"
    ).run();

    const createdCreates: RecordedCreate[] = [];
    const seenIds = new Set<string>();
    const fakeBinding = {
      create: async (options: { id?: string; params: { tenantId: string; employeeName: string } }) => {
        // Mirror the real runtime's two observable behaviors: ids must be
        // valid (the hashed form is proven against the real runtime below)
        // and a create for an id that already exists is REJECTED.
        if (options.id !== undefined && seenIds.has(options.id)) {
          throw new Error("Workflow instance with id already exists");
        }
        seenIds.add(options.id ?? `random-${createdCreates.length}`);
        createdCreates.push({ id: options.id, params: options.params });
        return { id: options.id ?? "instance" };
      },
    };
    const wakeEnv = { ...env, EMPLOYEE_CYCLE: fakeBinding };
    // The wake query selects EVERY tenant's employees on the shared test
    // database, so parallel test files' rows can appear too. Scope all
    // assertions to this test's own tenants to stay deterministic.
    const ownCreates = () =>
      createdCreates.filter((entry) => entry.params.tenantId.startsWith("t_wake_"));

    await wakeAllEmployees(wakeEnv as never);

    // One create attempt per roster row, with tenant-correct params.
    expect(ownCreates().length).toBe(3);
    expect(ownCreates().map((entry) => entry.params)).toContainEqual({
      tenantId: "t_wake_a",
      employeeName: "researcher",
    });
    expect(ownCreates().map((entry) => entry.params)).toContainEqual({
      tenantId: "t_wake_b",
      employeeName: "researcher",
    });
    expect(ownCreates().map((entry) => entry.params)).toContainEqual({
      tenantId: "t_wake_b",
      employeeName: "writer",
    });
    // Every cron create carries the deterministic id (no random-id fallback).
    for (const entry of ownCreates()) {
      expect(entry.id).toMatch(/^cron-[0-9a-f]{64}$/);
    }

    // The SAME hour has already been claimed — a second wake hits the
    // duplicate-id rejection for every employee, and wakeAllEmployees must
    // swallow exactly that error class rather than abort or double-create.
    await wakeAllEmployees(wakeEnv as never);
    expect(ownCreates().length).toBe(3);
  });

  it("hashes (tenant, employee, hour) into bounded, runtime-accepted ids, stable within the hour", async () => {
    const hourMs = 3_600_000;
    const now = 1_780_000_000_000;

    const firstRun = await buildCronCycleInstanceId("t_abc", "researcher", now);
    const sameHourAgain = await buildCronCycleInstanceId("t_abc", "researcher", now + 10 * 60 * 1000);
    const nextHour = await buildCronCycleInstanceId("t_abc", "researcher", now + hourMs);
    const otherTenant = await buildCronCycleInstanceId("t_def", "researcher", now);

    // Determinism within the hour, distinct across hours and tenants.
    expect(firstRun).toBe(sameHourAgain);
    expect(firstRun).not.toBe(nextHour);
    expect(firstRun).not.toBe(otherTenant);

    // Bounded length and a charset the Workflows runtime accepts (`:` is
    // rejected — verified against the real runtime when this scheme was
    // designed; hex + dash only).
    expect(firstRun).toMatch(/^cron-[0-9a-f]{64}$/);

    // And the runtime genuinely accepts such an id (not just pattern-valid).
    const accepted = await env.EMPLOYEE_CYCLE.create({
      id: firstRun,
      params: { tenantId: "t_abc", employeeName: "researcher" },
    });
    expect(accepted.id).toBe(firstRun);

    // Plus a duplicate create for the same id is rejected by the runtime —
    // this is what the cron dedupe relies on.
    await expect(
      env.EMPLOYEE_CYCLE.create({
        id: firstRun,
        params: { tenantId: "t_abc", employeeName: "researcher" },
      })
    ).rejects.toThrow();
  });
});
