import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepConfig,
} from "cloudflare:workers";
import type { Env } from "./env";
import { runEmployeeCycleWithBrain } from "./cycle";

export interface EmployeeCycleParams {
  // Fail-closed tenant context: the cycle refuses to run without it (see
  // the guard in run()) so a workflow can never fall back to a shared,
  // untenant-scoped execution path.
  tenantId: string;
  employeeName: string;
}

// The entire swamp-brain cycle (sandbox hydrate, research, Claude reflect,
// persist) is expensive and non-idempotent-if-partial, so a DEFAULT-retry
// step.do() (Workflows' default is effectively unlimited retries with no
// step timeout) would silently re-run the whole cycle over and over on any
// transient failure. This bounded config caps that blast radius: at most 2
// retries, backing off exponentially starting at 30 seconds, and the whole
// step is abandoned if it runs past 10 minutes.
const EMPLOYEE_CYCLE_STEP_CONFIG: WorkflowStepConfig = {
  retries: { limit: 2, delay: "30 seconds", backoff: "exponential" },
  timeout: "10 minutes",
};

// Durable wrapper around the cycle logic. The entire swamp-brain cycle runs
// inside a single step.do() so a crash before it completes simply re-runs
// the whole cycle rather than resuming from a partial, non-idempotent
// research/reflect state.
export class EmployeeCycle extends WorkflowEntrypoint<Env, EmployeeCycleParams> {
  async run(event: WorkflowEvent<EmployeeCycleParams>, step: WorkflowStep): Promise<void> {
    const { tenantId, employeeName } = event.payload;

    // Fail closed: a workflow instance missing its tenant context (e.g. an
    // old pre-multitenancy instance being retried after a deploy) must
    // error out, not silently run against a shared/default tenant scope.
    if (typeof tenantId !== "string" || tenantId.length === 0) {
      throw new Error("EmployeeCycle missing tenantId — refusing to run untenant-scoped");
    }

    await step.do("swamp-brain cycle", EMPLOYEE_CYCLE_STEP_CONFIG, () =>
      runEmployeeCycleWithBrain(this.env, tenantId, employeeName),
    );
  }
}
