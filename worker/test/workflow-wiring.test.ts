import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import type { WorkflowEvent, WorkflowStep, WorkflowStepContext } from "cloudflare:workers";
import { applyMigrations } from "./helpers/apply-migrations";
import { EmployeeCycle, type EmployeeCycleParams } from "../src/runtime/employee-cycle-workflow";

describe("EmployeeCycle workflow binding", () => {
  it("exposes a create() method on the workflow binding", () => {
    expect(typeof env.EMPLOYEE_CYCLE.create).toBe("function");
  });
});

describe("EmployeeCycle.run (the shipped orchestration path)", () => {
  beforeAll(async () => {
    await applyMigrations(env.DB);
  });

  it("delegates the whole cycle to a single durable 'swamp-brain cycle' step", async () => {
    const employeeName = "wf-tester";
    const stubId = env.EMPLOYEE.idFromName(employeeName);
    await env.EMPLOYEE.get(stubId).setGoal("grow dazl.ai on X");

    // A fake WorkflowStep that records the step name it was asked to
    // checkpoint, so this test proves run() wires up step.do() correctly
    // without needing the Workflows durable-execution runtime. It
    // deliberately does NOT invoke the real callback: that callback calls
    // runEmployeeCycleWithBrain() with the DEFAULT (container-backed) swamp
    // brain from Task 3, which needs a real Sandbox container and isn't
    // available under this test's wrangler config. The actual cycle logic —
    // goal -> research -> Claude reflect -> persisted lesson — is exercised
    // deterministically (via an injected fake Brain) by cycle.test.ts.
    const recordedStepNames: string[] = [];
    const fakeStep = {
      do: (async (name: string, _callback: (ctx: WorkflowStepContext) => Promise<unknown>) => {
        recordedStepNames.push(name);
        return undefined;
      }) as WorkflowStep["do"],
      sleep: async () => {},
      sleepUntil: async () => {},
      waitForEvent: async () => ({}) as never,
    } as unknown as WorkflowStep;

    const fakeEvent = {
      payload: { employeeName },
      timestamp: new Date(),
      instanceId: "test-instance",
      workflowName: "employee-cycle",
    } as WorkflowEvent<EmployeeCycleParams>;

    // workerd's native WorkflowEntrypoint constructor rejects any
    // ExecutionContext not created by an actual Workflow invocation (even
    // the test pool's own `createExecutionContext()` fails its brand
    // check), so the constructor cannot run here. Instead build the
    // instance via the prototype directly and set `env` on it exactly as
    // the real constructor would — `run()` only reads `this.env`, never
    // `this.ctx`, so this is sufficient to exercise the real orchestration.
    const workflow = Object.create(EmployeeCycle.prototype) as EmployeeCycle;
    (workflow as unknown as { env: typeof env }).env = env;
    await workflow.run(fakeEvent, fakeStep);

    expect(recordedStepNames).toEqual(["swamp-brain cycle"]);
  });
});
