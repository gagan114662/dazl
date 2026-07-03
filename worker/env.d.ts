// Shared environment bindings for the dazl runtime spine.
// Extends the existing proxy secrets with the new runtime bindings.
export interface Env {
  // Existing proxy secrets/vars
  ANTHROPIC_API_KEY: string;
  ELEVENLABS_API_KEY: string;
  ELEVENLABS_VOICE_ID: string;
  ASSEMBLYAI_API_KEY: string;

  // Runtime spine bindings (added in later tasks' wrangler.toml)
  DB: D1Database;
  EMPLOYEE: DurableObjectNamespace;
  EMPLOYEE_CYCLE: Workflow;
}

// Make `env` from "cloudflare:test" carry our Env type in tests.
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}
