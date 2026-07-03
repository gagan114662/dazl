import type { Env } from "./env";
import { recallRecentMemories } from "./memory";

// POST /employees — hire/assign an employee and start its first cycle.
export async function handleSpawnEmployee(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ employeeName: string; role: string; goal: string }>();

  const stubId = env.EMPLOYEE.idFromName(body.employeeName);
  await env.EMPLOYEE.get(stubId).setGoal(body.goal);

  await env.DB.prepare(
    "INSERT INTO employees (employee_name, role, goal) VALUES (?, ?, ?) " +
      "ON CONFLICT(employee_name) DO UPDATE SET role = excluded.role, goal = excluded.goal"
  ).bind(body.employeeName, body.role, body.goal).run();

  await env.EMPLOYEE_CYCLE.create({ params: { employeeName: body.employeeName } });

  return Response.json({ started: true });
}

// GET /employees/:employeeName — inspect goal + recent memories.
export async function handleInspectEmployee(employeeName: string, env: Env): Promise<Response> {
  const stubId = env.EMPLOYEE.idFromName(employeeName);
  const goal = await env.EMPLOYEE.get(stubId).getGoal();
  const memories = await recallRecentMemories(env.DB, employeeName, 20);
  return Response.json({ employeeName, goal, memories });
}

// Cron wake: start a cycle for every known employee.
export async function wakeAllEmployees(env: Env): Promise<void> {
  const result = await env.DB.prepare("SELECT employee_name FROM employees").all<{
    employee_name: string;
  }>();
  for (const row of result.results) {
    await env.EMPLOYEE_CYCLE.create({ params: { employeeName: row.employee_name } });
  }
}
