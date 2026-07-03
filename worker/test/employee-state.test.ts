import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("EmployeeState DO", () => {
  it("persists a goal per employee via RPC", async () => {
    const id = env.EMPLOYEE.idFromName("writer");
    const stub = env.EMPLOYEE.get(id);

    await stub.setGoal("write a launch post");
    const goal = await stub.getGoal();

    expect(goal).toBe("write a launch post");
  });
});
