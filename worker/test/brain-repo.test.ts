import { describe, it, expect } from "vitest";
import claudeAgentModel from "../brain-repo/models/claude-agent.yaml?raw";
// swamp only discovers workflow definitions from files named
// `workflow-<uuid>.yaml` directly under `workflows/` (unlike models, which
// swamp discovers by scanning file content regardless of filename/path —
// verified experimentally: renaming a workflow file away from this pattern
// made `swamp workflow search`/`validate` report "no workflows found"). So
// the on-disk file keeps swamp's required name; this import points at it
// directly rather than at an illustrative `research-cycle.yaml` path.
import researchWorkflow from "../brain-repo/workflows/workflow-5651817d-9036-49de-8c3a-798dc4d8a523.yaml?raw";

describe("swamp brain repo definitions", () => {
  it("claude-agent is a command/shell model", () => {
    expect(claudeAgentModel).toContain("command/shell");
    expect(claudeAgentModel).toContain("claude-agent");
  });
  it("research-cycle passes the task as an env var (injection-safe), not into the command", () => {
    expect(researchWorkflow).toContain("claude-agent");
    expect(researchWorkflow).toContain("AGENT_TASK"); // task flows via env
    expect(researchWorkflow).toContain('"$AGENT_TASK"'); // run references the env var
    expect(researchWorkflow).toContain("{{ inputs.task }}"); // bound to the workflow input
  });
});
