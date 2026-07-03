import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import type { WorkflowEvent, WorkflowStep, WorkflowStepContext } from "cloudflare:workers";
import { applyMigrations } from "./helpers/apply-migrations";
import { EmployeeCycle, type EmployeeCycleParams } from "../src/runtime/employee-cycle-workflow";
import { recallRecentMemories } from "../src/runtime/memory";

describe("EmployeeCycle workflow binding", () => {
  it("exposes a create() method on the workflow binding", () => {
    expect(typeof env.EMPLOYEE_CYCLE.create).toBe("function");
  });
});

describe("EmployeeCycle.run (the shipped orchestration path)", () => {
  beforeAll(async () => {
    await applyMigrations(env.DB);
  });

  it("persists a lesson memory when run() executes plan -> act -> reflect", async () => {
    const employeeName = "wf-tester";
    const stubId = env.EMPLOYEE.idFromName(employeeName);
    await env.EMPLOYEE.get(stubId).setGoal("grow dazl.ai on X");

    // A fake WorkflowStep whose do() just awaits and returns the callback's
    // result, so run() executes for real without needing the Workflows
    // durable-execution runtime. This directly exercises the shipped
    // EmployeeCycle.run() orchestration, not just the extracted
    // runEmployeeCycle() helper.
    const fakeStep = {
      do: (async (_name: string, callback: (ctx: WorkflowStepContext) => Promise<unknown>) => {
        return await callback({} as WorkflowStepContext);
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

    const memories = await recallRecentMemories(env.DB, employeeName, 20);
    const lessonMemory = memories.find((memory) => memory.kind === "lesson");
    expect(lessonMemory).toBeDefined();
  });
});
