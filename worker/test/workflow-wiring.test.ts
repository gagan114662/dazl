import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import type { WorkflowEvent, WorkflowStep, WorkflowStepContext } from "cloudflare:workers";
import { applyMigrations } from "./helpers/apply-migrations";
import { EmployeeCycle, type EmployeeCycleParams } from "../src/runtime/employee-cycle-workflow";
import { recallRecentMemories } from "../src/runtime/memory";
import type { Env } from "../src/runtime/env";

describe("EmployeeCycle workflow binding", () => {
  it("exposes a create() method on the workflow binding", () => {
    expect(typeof env.EMPLOYEE_CYCLE.create).toBe("function");
  });
});

// A minimal stand-in for the sandbox client that `getSandbox()` (from
// @cloudflare/sandbox, used by src/runtime/brain.ts) hands back to callers.
// `runResearchCycle`/`reflectWithClaude` only ever call `exec`, `writeFile`,
// `readFile`, and `deleteFile` on it (confirmed by reading brain.ts and the
// shipped @cloudflare/sandbox .d.ts), so those are the only methods this
// fake needs to implement.
interface FakeSandboxExecResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

function createFakeSandbox() {
  const fakeResearchArtifact =
    "Raw research: dazl.ai gains traction posting build-in-public progress threads on X.";
  const fakeReflectionLesson =
    "Lesson: post build-in-public progress threads on X to grow dazl.ai.";

  return {
    // `reflectWithClaude` runs a `claude -p "..."` command; every other
    // command in brain.ts (the swamp research-cycle run, the swamp data
    // get read-back, and the tar hydrate/persist commands) is treated as
    // the research side of the cycle. Branching on the command lets one
    // fake exec() plausibly stand in for both halves of the cycle.
    exec: async (command: string): Promise<FakeSandboxExecResult> => {
      const isClaudeReflectionCommand = command.startsWith("claude -p");
      return {
        success: true,
        stdout: isClaudeReflectionCommand ? fakeReflectionLesson : fakeResearchArtifact,
        stderr: "",
        exitCode: 0,
      };
    },
    writeFile: async () => ({}),
    readFile: async () => ({ content: "" }),
    deleteFile: async () => ({}),
  };
}

// A minimal stand-in for the SANDBOX DurableObjectNamespace binding.
// `getSandbox()` resolves the container stub via `@cloudflare/containers`'
// `getContainer(namespace, id)`, which just calls `namespace.idFromName(id)`
// then `namespace.get(objectId)` (confirmed by reading
// node_modules/@cloudflare/containers/dist/lib/utils.js) — so a plain object
// exposing those two methods is sufficient to stand in for the real
// namespace, without needing a real Durable Object or container.
function createFakeSandboxNamespace(fakeSandbox: ReturnType<typeof createFakeSandbox>) {
  return {
    idFromName: (name: string) => name,
    get: (_objectId: unknown) => fakeSandbox,
  };
}

describe("EmployeeCycle.run (the shipped orchestration path)", () => {
  beforeAll(async () => {
    await applyMigrations(env.DB);
  });

  it("runs the real step callback end-to-end, using a stubbed SANDBOX so no container is needed, and persists a lesson memory", async () => {
    const employeeName = "wf-run-tester";
    const stubId = env.EMPLOYEE.idFromName(employeeName);
    await env.EMPLOYEE.get(stubId).setGoal("test goal");

    // Everything except SANDBOX uses the real `cloudflare:test` bindings
    // (DB, EMPLOYEE, BRAIN_REPO). Only SANDBOX is stubbed, because the real
    // one is backed by an actual container that vitest-pool-workers can't
    // start ("Containers have not been enabled"). Stubbing at this level
    // (rather than injecting a fake Brain) lets this test exercise run()'s
    // real, unmodified delegation to runEmployeeCycleWithBrain() and its
    // default (container-backed) Brain.
    const fakeSandbox = createFakeSandbox();
    const fakeEnv = {
      ...env,
      SANDBOX: createFakeSandboxNamespace(fakeSandbox),
    } as unknown as Env;

    // A fake WorkflowStep whose do() actually invokes the callback (unlike
    // a step name-only stub), so this test proves run()'s body — not just
    // its wiring — actually executes.
    const recordedStepNames: string[] = [];
    const fakeStep = {
      do: (async (name: string, callback: (ctx: WorkflowStepContext) => Promise<unknown>) => {
        recordedStepNames.push(name);
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
    (workflow as unknown as { env: Env }).env = fakeEnv;
    await workflow.run(fakeEvent, fakeStep);

    expect(recordedStepNames).toEqual(["swamp-brain cycle"]);

    // The primary assertion: run()'s real body — goal -> research (via the
    // stubbed SANDBOX) -> Claude reflect (via the stubbed SANDBOX) ->
    // persisted memory — actually ran, not just a step-name stub.
    const memories = await recallRecentMemories(env.DB, employeeName, 1);
    expect(memories[0]?.kind).toBe("lesson");
    expect(memories[0]?.content.length).toBeGreaterThan(0);
  });
});
