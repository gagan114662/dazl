import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("Sandbox + brain bindings", () => {
  it("exposes SANDBOX and BRAIN_REPO", () => {
    expect(env.SANDBOX).toBeDefined();
    expect(typeof env.SANDBOX.idFromName).toBe("function");
    expect(env.BRAIN_REPO).toBeDefined();
  });
});
