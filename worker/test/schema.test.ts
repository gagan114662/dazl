import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { applyMigrations } from "./helpers/apply-migrations";

describe("D1 schema", () => {
  beforeAll(async () => {
    await applyMigrations(env.DB);
  });

  it("has a memory table that stores a fact for an employee", async () => {
    await env.DB.prepare(
      "INSERT INTO memory (employee_name, kind, content) VALUES (?, ?, ?)"
    ).bind("writer", "lesson", "threads at 9am beat memes").run();

    const row = await env.DB.prepare(
      "SELECT employee_name, kind, content FROM memory WHERE employee_name = ?"
    ).bind("writer").first<{ employee_name: string; kind: string; content: string }>();

    expect(row?.content).toBe("threads at 9am beat memes");
  });
});
