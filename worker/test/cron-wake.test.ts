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
// deterministic per-hour id, and must not create again for the same employee
// within the same clock hour (dedupe via the cycle_runs D1 claim — NOT via
// the Workflows runtime, which empirically does not reject duplicate ids).
describe("cron wake (wakeAllEmployees)", () => {
  beforeAll(async () => {
    await applyMigrations(env.DB);
  });

  it("creates one workflow per employee with tenant-correct params, and does not re-create within the hour", async () => {
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
    const fakeBinding = {
      create: async (options: { id?: string; params: { tenantId: string; employeeName: string } }) => {
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

    // The SAME hour has already been claimed — a second wake must skip all
    // three employees entirely (D1 claim, not runtime duplicate rejection).
    await wakeAllEmployees(wakeEnv as never);
    expect(ownCreates().length).toBe(3);

    // And the claims are visible in the ledger for this hour.
    const claimedRows = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM cycle_runs WHERE tenant_id IN ('t_wake_a', 't_wake_b')"
    ).first<{ n: number }>();
    expect(claimedRows!.n).toBe(3);
  });

  it("rolls back the claim when the workflow create fails, so the next wake retries", async () => {
    await env.DB.prepare(
      "INSERT INTO tenants (tenant_id, name) VALUES ('t_wake_fail', 'wake fail') ON CONFLICT(tenant_id) DO NOTHING"
    ).run();
    await env.DB.prepare(
      "INSERT INTO employees (tenant_id, employee_name, role, goal) VALUES " +
        "('t_wake_fail', 'flaky', 'Analyst', 'goal') ON CONFLICT(tenant_id, employee_name) DO NOTHING"
    ).run();

    // Fail creates ONLY for this test's tenant: the wake iterates every
    // employee on the shared test database, so an unconditional failure
    // would hit another test file's employee first. After the first wake,
    // the failure is turned off so the retry can succeed.
    let failForThisTenant = true;
    const failingBinding = {
      create: async (options: { id?: string; params: { tenantId: string; employeeName: string } }) => {
        if (failForThisTenant && options.params.tenantId === "t_wake_fail") {
          throw new Error("simulated create failure");
        }
        return { id: options.id ?? "instance" };
      },
    };

    // First wake: create fails -> claim must be rolled back (no lost hour).
    await wakeAllEmployees({ ...env, EMPLOYEE_CYCLE: failingBinding } as never);

    const claimsAfterFailure = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM cycle_runs WHERE tenant_id = 't_wake_fail'"
    ).first<{ n: number }>();
    expect(claimsAfterFailure!.n).toBe(0);

    // Next wake: create succeeds now, claim recorded.
    failForThisTenant = false;
    await wakeAllEmployees({ ...env, EMPLOYEE_CYCLE: failingBinding } as never);
    const claimsAfterSuccess = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM cycle_runs WHERE tenant_id = 't_wake_fail'"
    ).first<{ n: number }>();
    expect(claimsAfterSuccess!.n).toBe(1);
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

    // Bounded length and a charset the Workflows runtime accepts (the raw
    // `tenant::name:hour` form is rejected — `:` is not allowed in ids,
    // verified against the real runtime).
    expect(firstRun).toMatch(/^cron-[0-9a-f]{64}$/);

    // And the runtime genuinely accepts such an id (not just pattern-valid).
    // NOTE: a duplicate create with the same id does NOT throw in this
    // runtime (verified empirically) — which is exactly why the cron dedupe
    // is enforced by the cycle_runs D1 claim, not by instance-id collision.
    const accepted = await env.EMPLOYEE_CYCLE.create({
      id: firstRun,
      params: { tenantId: "t_abc", employeeName: "researcher" },
    });
    expect(accepted.id).toBe(firstRun);
  });
});
