import { describe, it, expect } from "vitest";
import { isAuthorized } from "../src/runtime/routes";

describe("isAuthorized", () => {
  it("denies a request sending the literal Bearer undefined string when DAZL_API_SECRET is unset", () => {
    const requestWithUndefinedSecret = new Request("https://x/employees", {
      headers: { Authorization: "Bearer undefined" },
    });

    expect(isAuthorized(requestWithUndefinedSecret, { DAZL_API_SECRET: "" } as any)).toBe(false);
  });

  it("denies a request sending a Bearer header with a trailing space when DAZL_API_SECRET is empty", () => {
    const requestWithEmptySecret = new Request("https://x/employees", {
      headers: { Authorization: "Bearer " },
    });

    expect(isAuthorized(requestWithEmptySecret, { DAZL_API_SECRET: "" } as any)).toBe(false);
  });

  it("still authorizes a request with the correct secret when DAZL_API_SECRET is configured", () => {
    const requestWithCorrectSecret = new Request("https://x/employees", {
      headers: { Authorization: "Bearer s3cret" },
    });

    expect(isAuthorized(requestWithCorrectSecret, { DAZL_API_SECRET: "s3cret" } as any)).toBe(true);
  });
});
