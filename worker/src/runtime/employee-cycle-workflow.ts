import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "./env";
import { runEmployeeCycleWithBrain } from "./cycle";

export interface EmployeeCycleParams {
  employeeName: string;
}

// Durable wrapper around the cycle logic. The entire swamp-brain cycle runs
// inside a single step.do() so a crash before it completes simply re-runs
// the whole cycle rather than resuming from a partial, non-idempotent
// research/reflect state.
export class EmployeeCycle extends WorkflowEntrypoint<Env, EmployeeCycleParams> {
  async run(event: WorkflowEvent<EmployeeCycleParams>, step: WorkflowStep): Promise<void> {
    const { employeeName } = event.payload;

    await step.do("swamp-brain cycle", () => runEmployeeCycleWithBrain(this.env, employeeName));
  }
}
