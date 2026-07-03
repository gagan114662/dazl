import { describe, it, expect } from "vitest";
import { buildResearchCommand, buildResearchStdin } from "../src/runtime/brain";

describe("research command is injection-safe by construction", () => {
  it("the exec command is static-shaped and runs the workflow via --stdin, redirecting the given path", () => {
    const command = buildResearchCommand("/tmp/x.json");
    expect(command).toContain("swamp --no-telemetry workflow run research-cycle");
    expect(command).toContain("--stdin");
    expect(command).toContain("< /tmp/x.json");
  });

  it("a malicious task appears ONLY in the stdin JSON, never in the command", () => {
    const evil = `x"; rm -rf / #`;
    const stdin = buildResearchStdin(evil);
    expect(JSON.parse(stdin).task).toBe(evil); // preserved verbatim as data
    const command = buildResearchCommand("/tmp/x.json");
    expect(command).not.toContain("rm -rf"); // never in the shell command
    expect(command).not.toContain(evil);
  });

  it("buildResearchCommand only ever weaves in the stdin file path, never a task", () => {
    // The function's parameter is a stdin file path (a UUID-based path, no
    // shell metacharacters) — reinforces that there is no code path where a
    // task could be woven into the command string.
    const command = buildResearchCommand("/tmp/dazl-research-11111111-2222-3333-4444-555555555555.json");
    expect(typeof command).toBe("string");
    expect(command).toBe(
      "swamp --no-telemetry workflow run research-cycle --stdin --json < /tmp/dazl-research-11111111-2222-3333-4444-555555555555.json",
    );
  });

  it("two calls with different stdin paths produce different commands, proving the path is per-call, not fixed", () => {
    const commandOne = buildResearchCommand("/tmp/dazl-research-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.json");
    const commandTwo = buildResearchCommand("/tmp/dazl-research-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.json");
    expect(commandOne).not.toBe(commandTwo);
  });
});
