import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { applyMigrations } from "./helpers/apply-migrations";
import worker from "../src/index";

describe("employee routes", () => {
  beforeAll(async () => {
    await applyMigrations(env.DB);
  });

  it("spawns an employee and reads it back", async () => {
    const spawn = new Request("https://x/employees", {
      method: "POST",
      body: JSON.stringify({ employeeName: "writer", role: "Writer", goal: "write launch post" }),
    });
    const ctx = createExecutionContext();
    const spawnResponse = await worker.fetch(spawn, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(spawnResponse.status).toBe(200);

    const inspect = new Request("https://x/employees/writer", { method: "GET" });
    const ctx2 = createExecutionContext();
    const inspectResponse = await worker.fetch(inspect, env, ctx2);
    await waitOnExecutionContext(ctx2);
    const data = await inspectResponse.json<{ goal: string; employeeName: string }>();

    expect(data.employeeName).toBe("writer");
    expect(data.goal).toBe("write launch post");
  });

  it("keeps the existing proxy 404 for unknown routes", async () => {
    const req = new Request("https://x/nope", { method: "GET" });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(404);
  });
});
