import type { Env } from "./env";
import { rememberFact } from "./memory";

export type PlannedAction = { action: "research"; query: string };

// PLAN: decide the next action from the current goal.
// Phase 1 always researches; later phases add real Claude-driven planning.
export function planNextAction(goal: string | null): PlannedAction {
  const query = goal ?? "what should dazl.ai talk about";
  return { action: "research", query };
}

// ACT: perform a REAL http request and return an observation string.
// fetchImpl is injectable so tests stay deterministic; defaults to global fetch.
export async function act(
  action: PlannedAction,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const response = await fetchImpl("https://example.com/");
  const body = await response.text();
  return body.slice(0, 500);
}

// REFLECT: turn the observation into a durable lesson in D1.
export async function reflect(
  env: Env,
  employeeName: string,
  observation: string
): Promise<void> {
  const lesson = `Observed while researching: ${observation.slice(0, 200)}`;
  await rememberFact(env.DB, employeeName, "lesson", lesson);
}

// Orchestrate one full cycle. The Workflow (Task 6) calls the three
// functions individually inside step.do() for durability; this helper
// keeps the logic testable outside the Workflows runtime.
export async function runEmployeeCycle(
  env: Env,
  employeeName: string,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const stubId = env.EMPLOYEE.idFromName(employeeName);
  const goal = await env.EMPLOYEE.get(stubId).getGoal();

  const action = planNextAction(goal);
  const observation = await act(action, fetchImpl);
  await reflect(env, employeeName, observation);
  return observation;
}
