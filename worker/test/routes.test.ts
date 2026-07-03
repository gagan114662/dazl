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
      headers: { Authorization: "Bearer test-secret" },
      body: JSON.stringify({ employeeName: "writer", role: "Writer", goal: "write launch post" }),
    });
    const ctx = createExecutionContext();
    const spawnResponse = await worker.fetch(spawn, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(spawnResponse.status).toBe(200);

    const inspect = new Request("https://x/employees/writer", {
      method: "GET",
      headers: { Authorization: "Bearer test-secret" },
    });
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

  it("rejects a spawn request missing the Authorization header with 401", async () => {
    const spawn = new Request("https://x/employees", {
      method: "POST",
      body: JSON.stringify({ employeeName: "no-auth", role: "Writer", goal: "write launch post" }),
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(spawn, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(401);
    const data = await response.json<{ error: string }>();
    expect(data.error).toBe("unauthorized");
  });

  it("rejects a spawn request with an incorrect secret with 401", async () => {
    const spawn = new Request("https://x/employees", {
      method: "POST",
      headers: { Authorization: "Bearer wrong-secret" },
      body: JSON.stringify({ employeeName: "no-auth", role: "Writer", goal: "write launch post" }),
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(spawn, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(401);
  });

  it("rejects an inspect request missing the Authorization header with 401", async () => {
    const inspect = new Request("https://x/employees/writer", { method: "GET" });
    const ctx = createExecutionContext();
    const response = await worker.fetch(inspect, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(401);
    const data = await response.json<{ error: string }>();
    expect(data.error).toBe("unauthorized");
  });

  it("rejects a spawn request with an invalid employeeName with 400", async () => {
    const spawn = new Request("https://x/employees", {
      method: "POST",
      headers: { Authorization: "Bearer test-secret" },
      body: JSON.stringify({
        employeeName: "Not Valid!",
        role: "Writer",
        goal: "write launch post",
      }),
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(spawn, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(400);
    const data = await response.json<{ error: string }>();
    expect(typeof data.error).toBe("string");
  });
});
