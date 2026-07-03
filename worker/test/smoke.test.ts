import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("workers test pool", () => {
  it("boots and exposes bindings", () => {
    expect(env).toBeDefined();
  });
});
