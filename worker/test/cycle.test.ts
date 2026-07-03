import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { applyMigrations } from "./helpers/apply-migrations";
import { runEmployeeCycleWithBrain } from "../src/runtime/cycle";
import { recallRecentMemories } from "../src/runtime/memory";

describe("employee cycle", () => {
  beforeAll(async () => {
    await applyMigrations(env.DB);
  });

  it("runs a swamp-brain cycle and stores the Claude-reflected lesson", async () => {
    const fakeBrain = {
      runResearchCycle: async (_e: any, task: string) => {
        expect(task.length).toBeGreaterThan(0);
        return { artifact: "raw research about AI marketing tools" };
      },
      reflectWithClaude: async () => "Lesson: launch on dev communities first.",
    };
    await runEmployeeCycleWithBrain(env as any, "swamp-tester", fakeBrain);
    const memories = await recallRecentMemories(env.DB, "swamp-tester", 5);
    expect(memories[0].kind).toBe("lesson");
    expect(memories[0].content).toContain("dev communities");
  });
});
