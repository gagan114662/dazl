import { runResearchCycle as defaultRunResearchCycle, reflectWithClaude as defaultReflectWithClaude } from "./brain";
import { rememberFact } from "./memory";
import type { Env } from "./env";

// Injectable seam over the swamp brain (Task 2/3): a real research cycle run
// in the Sandbox container, plus a Claude reflection over its artifact. Tests
// inject a fake Brain so they stay deterministic and don't need a container.
export interface Brain {
  runResearchCycle: (env: Env, task: string) => Promise<{ artifact: string }>;
  reflectWithClaude: (env: Env, artifact: string) => Promise<string>;
}

const defaultBrain: Brain = {
  runResearchCycle: defaultRunResearchCycle,
  reflectWithClaude: defaultReflectWithClaude,
};

// One full employee cycle driven by the swamp brain: read the employee's
// goal from its EmployeeState Durable Object, turn it into a research task,
// run that task through the swamp brain's research-cycle workflow to get a
// versioned artifact, have Claude reflect on the artifact into a single
// marketing lesson, and persist that lesson as durable memory.
export async function runEmployeeCycleWithBrain(
  env: Env,
  employeeName: string,
  brain: Brain = defaultBrain
): Promise<void> {
  const employeeStateId = env.EMPLOYEE.idFromName(employeeName);
  const goal = await env.EMPLOYEE.get(employeeStateId).getGoal();
  const researchTask = `Research this for dazl marketing and report key findings: ${goal ?? "grow dazl.ai"}`;

  const { artifact } = await brain.runResearchCycle(env, researchTask);
  const lesson = await brain.reflectWithClaude(env, artifact);

  await rememberFact(env.DB, employeeName, "lesson", lesson || artifact.slice(0, 200));
}
