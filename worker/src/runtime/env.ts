// Re-export the ambient Env as a real, importable type module.
export interface Env {
  ANTHROPIC_API_KEY: string;
  ELEVENLABS_API_KEY: string;
  ELEVENLABS_VOICE_ID: string;
  ASSEMBLYAI_API_KEY: string;
  DB: D1Database;
  EMPLOYEE: DurableObjectNamespace<import("./employee-state").EmployeeState>;
  EMPLOYEE_CYCLE: Workflow;
}
