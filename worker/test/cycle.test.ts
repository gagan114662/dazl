import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { applyMigrations } from "./helpers/apply-migrations";
import { planNextAction, runEmployeeCycle } from "../src/runtime/cycle";
import { recallRecentMemories } from "../src/runtime/memory";

describe("employee cycle", () => {
  beforeAll(async () => {
    await applyMigrations(env.DB);
  });

  it("plans a research action from a goal", () => {
    const action = planNextAction("grow dazl.ai on X");
    expect(action.action).toBe("research");
    expect(action.query.length).toBeGreaterThan(0);
  });

  it("runs a full cycle and persists a lesson from a real fetch", async () => {
    // Inject a fake fetch so the test is deterministic (real signature).
    const fakeFetch = (async () =>
      new Response("Example Domain — reference content")) as typeof fetch;

    const observation = await runEmployeeCycle(env, "researcher", fakeFetch);

    expect(observation).toContain("Example Domain");

    const memories = await recallRecentMemories(env.DB, "researcher", 5);
    expect(memories.length).toBe(1);
    expect(memories[0].kind).toBe("lesson");
    expect(memories[0].content).toContain("Example Domain");
  });
});
