import { describe, it, expect } from "vitest";
import { RESEARCH_COMMAND, buildResearchStdin } from "../src/runtime/brain";

describe("research command is injection-safe by construction", () => {
  it("the exec command is static and runs the workflow via --stdin", () => {
    expect(RESEARCH_COMMAND).toContain("swamp --no-telemetry workflow run research-cycle");
    expect(RESEARCH_COMMAND).toContain("--stdin");
  });

  it("a malicious task appears ONLY in the stdin JSON, never in the command", () => {
    const evil = `x"; rm -rf / #`;
    const stdin = buildResearchStdin(evil);
    expect(JSON.parse(stdin).task).toBe(evil); // preserved verbatim as data
    expect(RESEARCH_COMMAND).not.toContain("rm -rf"); // never in the shell command
  });

  it("RESEARCH_COMMAND never changes shape based on input (it takes none)", () => {
    // RESEARCH_COMMAND is a constant, not a function of task — reinforces that
    // there is no code path where a task could be woven into the command string.
    expect(typeof RESEARCH_COMMAND).toBe("string");
    expect(RESEARCH_COMMAND).not.toMatch(/\$\{|`|\+ ?task/);
  });
});
