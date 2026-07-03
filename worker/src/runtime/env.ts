// Re-export the ambient Env as a real, importable type module.
export interface Env {
  ANTHROPIC_API_KEY: string;
  ELEVENLABS_API_KEY: string;
  ELEVENLABS_VOICE_ID: string;
  ASSEMBLYAI_API_KEY: string;
  // Shared secret required (as `Authorization: Bearer <DAZL_API_SECRET>`) on the
  // dazl employee HTTP routes (POST /employees, GET /employees/:employeeName).
  DAZL_API_SECRET: string;
  DB: D1Database;
  EMPLOYEE: DurableObjectNamespace<import("./employee-state").EmployeeState>;
  EMPLOYEE_CYCLE: Workflow;
}
