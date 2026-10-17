import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { applyMigrations } from "./helpers/apply-migrations";
import { rememberFact, recallRecentMemories } from "../src/runtime/memory";

describe("memory DAL", () => {
  beforeAll(async () => {
    await applyMigrations(env.DB);
  });

  it("stores and recalls newest-first, scoped to one tenant", async () => {
    await rememberFact(env.DB, "tenant-m1", "analyst", "fact", "site has 12 blog posts");
    await rememberFact(env.DB, "tenant-m1", "analyst", "lesson", "long posts rank better");
    // A second tenant's identically-named employee must be invisible to the
    // first tenant's recall.
    await rememberFact(env.DB, "tenant-m2", "analyst", "fact", "tenant 2's fact");

    const memories = await recallRecentMemories(env.DB, "tenant-m1", "analyst", 10);

    expect(memories.length).toBe(2);
    expect(memories[0].content).toBe("long posts rank better"); // newest first
    expect(memories[0].kind).toBe("lesson");
    expect(memories[0].employeeName).toBe("analyst");

    const tenantTwoMemories = await recallRecentMemories(env.DB, "tenant-m2", "analyst", 10);
    expect(tenantTwoMemories.map((m) => m.content)).toEqual(["tenant 2's fact"]);
  });
});
