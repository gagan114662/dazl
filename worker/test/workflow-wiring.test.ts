import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("EmployeeCycle workflow binding", () => {
  it("exposes a create() method on the workflow binding", () => {
    expect(typeof env.EMPLOYEE_CYCLE.create).toBe("function");
  });
});
