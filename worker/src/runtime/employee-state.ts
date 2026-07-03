import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

// One instance per employee. Holds the employee's live goal in durable
// storage so it survives restarts, evictions, and multi-day sleeps.
export class EmployeeState extends DurableObject<Env> {
  async setGoal(goal: string): Promise<void> {
    await this.ctx.storage.put("goal", goal);
  }

  async getGoal(): Promise<string | null> {
    const goal = await this.ctx.storage.get<string>("goal");
    return goal ?? null;
  }
}
