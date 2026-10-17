import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { applyMigrations } from "./helpers/apply-migrations";
import worker from "../src/index";
import { runEmployeeCycleWithBrain, getEffectiveGoal } from "../src/runtime/cycle";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The per-tenant lock serializes brain cycles because one tenant's employees
// share that tenant's single sandbox workspace (hydrate -> run -> persist):
// concurrent same-tenant cycles would interleave and overwrite each other's
// snapshots. These tests prove the lock semantics and the actual serialization
// (plus cross-tenant independence), and that /v1 failures don't leak error
// details to callers.
describe("tenant cycle lock", () => {
  beforeAll(async () => {
    await applyMigrations(env.DB);
  });

  it("acquires, denies a second holder, and releases only to the holder", async () => {
    const lock = env.TENANT_LOCK.get(env.TENANT_LOCK.idFromName("t_lock_sem"));

    expect(await lock.acquire("holder-a", 60_000)).toBe(true);
    expect(await lock.acquire("holder-b", 60_000)).toBe(false);

    // A non-holder's release must not free the lock.
    await lock.release("holder-b");
    expect(await lock.acquire("holder-c", 60_000)).toBe(false);

    await lock.release("holder-a");
    expect(await lock.acquire("holder-c", 60_000)).toBe(true);
    await lock.release("holder-c");
  });

  it("takes over an expired lock (a crashed holder cannot deadlock its tenant)", async () => {
    const lock = env.TENANT_LOCK.get(env.TENANT_LOCK.idFromName("t_lock_ttl"));

    expect(await lock.acquire("crashed-holder", 50)).toBe(true);
    await sleep(80); // let it expire
    expect(await lock.acquire("fresh-holder", 60_000)).toBe(true);
    await lock.release("fresh-holder");
  });

  it("serializes same-tenant cycles but not cross-tenant cycles", async () => {
    const events: string[] = [];
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    const gatedBrain = {
      runResearchCycle: async (_env: unknown, tenantId: string, _task: string) => {
        events.push(`start:${tenantId}`);
        if (tenantId === "t_ser") await gate; // first t_ser cycle blocks here
        events.push(`end:${tenantId}`);
        return { artifact: "artifact" };
      },
      reflectWithClaude: async () => "lesson",
    };

    // Cycle 1 (t_ser) starts and blocks inside the brain.
    const first = runEmployeeCycleWithBrain(env as never, "t_ser", "employee-one", gatedBrain);
    await sleep(150);
    expect(events).toEqual(["start:t_ser"]);

    // Cycle 2 (SAME tenant) must NOT start — it waits on the lock, and must
    // not call into the brain while cycle 1 holds it.
    const second = runEmployeeCycleWithBrain(env as never, "t_ser", "employee-two", gatedBrain);
    await sleep(300);
    expect(events).toEqual(["start:t_ser"]);

    // A DIFFERENT tenant's cycle is independent — it runs concurrently.
    const third = runEmployeeCycleWithBrain(env as never, "t_other", "employee-three", gatedBrain);
    await sleep(300);
    expect(events).toContain("start:t_other");
    expect(events).toContain("end:t_other");

    // Release the gate: cycle 1 finishes, THEN cycle 2 runs (serialized).
    releaseGate!();
    await Promise.all([first, second, third]);

    const serEvents = events.filter((event) => event.endsWith(":t_ser"));
    expect(serEvents).toEqual(["start:t_ser", "end:t_ser", "start:t_ser", "end:t_ser"]);
    // No overlap: the second t_ser start came after the first t_ser end.
    expect(serEvents.indexOf("start:t_ser", 1)).toBeGreaterThan(serEvents.indexOf("end:t_ser"));
  });

  it("releases the lock even when the cycle fails, and does not write the lesson", async () => {
    const failingBrain = {
      runResearchCycle: async () => {
        throw new Error("brain exploded");
      },
      reflectWithClaude: async () => "unreachable",
    };

    await expect(
      runEmployeeCycleWithBrain(env as never, "t_fail", "employee-fail", failingBrain)
    ).rejects.toThrow("brain exploded");

    // The lock is free again — a new cycle acquires immediately.
    const lock = env.TENANT_LOCK.get(env.TENANT_LOCK.idFromName("t_fail"));
    expect(await lock.acquire("probe", 60_000)).toBe(true);
    await lock.release("probe");

    // And no lesson memory was written for the failed cycle.
    const goal = await getEffectiveGoal(env as never, "t_fail", "employee-fail");
    expect(goal).toBeNull();
  });

  it("returns a generic 500 without leaking error details from the /v1 path", async () => {
    // A DB failure during auth lookup must surface as a generic 500 — the
    // outer /v1 catch must not echo String(error) to the caller.
    const brokenEnv = {
      ...env,
      DB: {
        prepare: () => {
          throw new Error("D1 exploded: internal-table-boom");
        },
        batch: async () => {
          throw new Error("D1 exploded: internal-table-boom");
        },
      },
    };

    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://x/v1/employees", {
        headers: { Authorization: "Bearer dazl_anykey" },
      }),
      brokenEnv as never,
      ctx
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain("internal error");
    expect(body).not.toContain("D1 exploded");
    expect(body).not.toContain("internal-table-boom");
  });
});
