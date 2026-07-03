import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "./env";
import { planNextAction, act, reflect } from "./cycle";

export interface EmployeeCycleParams {
  employeeName: string;
}

// Durable wrapper around the cycle logic. Each step.do() checkpoints, so a
// crash resumes mid-cycle instead of restarting.
export class EmployeeCycle extends WorkflowEntrypoint<Env, EmployeeCycleParams> {
  async run(event: WorkflowEvent<EmployeeCycleParams>, step: WorkflowStep): Promise<void> {
    const { employeeName } = event.payload;

    const goal = await step.do("plan: read goal", async () => {
      const stubId = this.env.EMPLOYEE.idFromName(employeeName);
      return await this.env.EMPLOYEE.get(stubId).getGoal();
    });

    const observation = await step.do("act: research", async () => {
      const action = planNextAction(goal);
      return await act(action);
    });

    await step.do("reflect: persist lesson", async () => {
      await reflect(this.env, employeeName, observation);
    });
  }
}
