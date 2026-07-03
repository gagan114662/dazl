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
  // Sandbox container running Claude Code + swamp (the "brain" — see
  // worker/Dockerfile). One binding, hydrated per cycle from BRAIN_REPO.
  SANDBOX: DurableObjectNamespace<import("@cloudflare/sandbox").Sandbox>;
  // Subscription auth for Claude Code inside the Sandbox container (from
  // `claude setup-token`), set via `npx wrangler secret put CLAUDE_CODE_OAUTH_TOKEN`.
  CLAUDE_CODE_OAUTH_TOKEN: string;
  // R2-persisted swamp brain repo (workflows, models, versioned artifacts),
  // synced to/from the Sandbox container's /brain directory each cycle.
  BRAIN_REPO: R2Bucket;
}
