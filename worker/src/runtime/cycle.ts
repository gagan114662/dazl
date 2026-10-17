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

// Resolve an employee's effective goal, hydrating the tenant-namespaced DO
// from the D1 roster row when the DO has none.
//
// Cutover preservation: after the multitenancy migration, DOs are addressed
// as `${tenantId}::${employeeName}` while pre-migration employees' goals
// live on in the D1 roster rows. Without this fallback, the newly-addressed
// DOs start goal-less and cycles would silently research the generic
// "grow dazl.ai" fallback instead of the employee's actual goal.
export async function getEffectiveGoal(env: Env, tenantId: string, employeeName: string): Promise<string | null> {
  const employeeStateId = env.EMPLOYEE.idFromName(`${tenantId}::${employeeName}`);
  const stub = env.EMPLOYEE.get(employeeStateId);

  let goal = await stub.getGoal();
  if (goal === null) {
    const rosterRow = await env.DB.prepare(
      "SELECT goal FROM employees WHERE tenant_id = ? AND employee_name = ?"
    ).bind(tenantId, employeeName).first<{ goal: string | null }>();

    // Only a non-empty roster goal is worth hydrating; otherwise leave the DO
    // untouched so callers see a truthful null.
    if (rosterRow?.goal != null && rosterRow.goal.length > 0) {
      goal = rosterRow.goal;
      await stub.setGoal(goal);
    }
  }
  return goal;
}

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
  const goal = await getEffectiveGoal(env, tenantId, employeeName);
  const researchTask = `Research this for dazl marketing and report key findings: ${goal ?? "grow dazl.ai"}`;

  const { artifact } = await brain.runResearchCycle(env, tenantId, researchTask);
  const lesson = await brain.reflectWithClaude(env, tenantId, artifact);

  await rememberFact(env.DB, tenantId, employeeName, "lesson", lesson || artifact.slice(0, 200));
}
