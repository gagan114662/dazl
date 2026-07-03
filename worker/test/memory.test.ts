import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { applyMigrations } from "./helpers/apply-migrations";
import { rememberFact, recallRecentMemories } from "../src/runtime/memory";

describe("memory DAL", () => {
  beforeAll(async () => {
    await applyMigrations(env.DB);
  });

  it("stores and recalls newest-first", async () => {
    await rememberFact(env.DB, "analyst", "fact", "site has 12 blog posts");
    await rememberFact(env.DB, "analyst", "lesson", "long posts rank better");

    const memories = await recallRecentMemories(env.DB, "analyst", 10);

    expect(memories.length).toBe(2);
    expect(memories[0].content).toBe("long posts rank better"); // newest first
    expect(memories[0].kind).toBe("lesson");
    expect(memories[0].employeeName).toBe("analyst");
  });
});
