import { runResearchCycle as defaultRunResearchCycle, reflectWithClaude as defaultReflectWithClaude } from "./brain";
import { rememberFact } from "./memory";
import type { Env } from "./env";

// Injectable seam over the swamp brain (Task 2/3): a real research cycle run
// in the Sandbox container, plus a Claude reflection over its artifact. Tests
// inject a fake Brain so they stay deterministic and don't need a container.
export interface Brain {
  runResearchCycle: (env: Env, tenantId: string, task: string) => Promise<{ artifact: string }>;
  reflectWithClaude: (env: Env, tenantId: string, artifact: string) => Promise<string>;
}

const defaultBrain: Brain = {
  runResearchCycle: defaultRunResearchCycle,
  reflectWithClaude: defaultReflectWithClaude,
};

// One full employee cycle driven by the swamp brain: read the employee's
// goal from its tenant-namespaced EmployeeState Durable Object, turn it into
// a research task, run that task through the tenant's swamp brain research
// cycle to get a versioned artifact, have Claude reflect on the artifact into
// a single marketing lesson, and persist that lesson as tenant-scoped memory.
// The tenantId threads through EVERY stage — DO lookup, sandbox selection,
// R2 persistence, memory write — so a cycle can never read another tenant's
// goal, run in another tenant's brain, or write another tenant's memory.
export async function runEmployeeCycleWithBrain(
  env: Env,
  tenantId: string,
  employeeName: string,
  brain: Brain = defaultBrain
): Promise<void> {
  const employeeStateId = env.EMPLOYEE.idFromName(`${tenantId}::${employeeName}`);
  const goal = await env.EMPLOYEE.get(employeeStateId).getGoal();
  const researchTask = `Research this for dazl marketing and report key findings: ${goal ?? "grow dazl.ai"}`;

  const { artifact } = await brain.runResearchCycle(env, tenantId, researchTask);
  const lesson = await brain.reflectWithClaude(env, tenantId, artifact);

  await rememberFact(env.DB, tenantId, employeeName, "lesson", lesson || artifact.slice(0, 200));
}
