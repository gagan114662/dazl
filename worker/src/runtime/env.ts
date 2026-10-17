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
  // Per-tenant mutual-exclusion lock serializing each tenant's brain cycles
  // (they share that tenant's single sandbox workspace). See tenant-lock.ts.
  TENANT_LOCK: DurableObjectNamespace<import("./tenant-lock").TenantLock>;
  EMPLOYEE_CYCLE: Workflow;
  // Sandbox container running Claude Code + swamp (the "brain" — see
  // worker/Dockerfile). One binding, hydrated per cycle from BRAIN_REPO.
  SANDBOX: DurableObjectNamespace<import("@cloudflare/sandbox").Sandbox>;
  // Subscription auth for Claude Code inside the Sandbox container (from
  // `claude setup-token`), set via `npx wrangler secret put CLAUDE_CODE_OAUTH_TOKEN`.
  CLAUDE_CODE_OAUTH_TOKEN: string;
  // R2-persisted swamp brain repo (workflows, models, versioned artifacts),
  // synced to/from the Sandbox container's /brain directory each cycle.
  // Snapshots are stored per tenant under `tenants/<tenantId>/…`.
  BRAIN_REPO: R2Bucket;
  // OPTIONAL shared secret for the legacy proxy routes (/chat, /tts,
  // /transcribe-token). When unset (the default) those routes stay open as
  // they are today so the shipped Swift app keeps working; once the Swift app
  // sends `Authorization: Bearer <PROXY_SHARED_SECRET>`, set this via
  // `npx wrangler secret put PROXY_SHARED_SECRET` to close them.
  PROXY_SHARED_SECRET?: string;
  // Model for tenant-facing generation (scoring, drafts, creatives).
  LLM_MODEL?: string;
  // Outbound email (Resend). Sending is disabled (503) until both are set.
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  // Public https origin of this worker (used in unsubscribe links).
  PUBLIC_BASE_URL?: string;
  // HMAC key for unsubscribe links; falls back to DAZL_API_SECRET.
  UNSUBSCRIBE_SECRET?: string;
  // Stripe billing. Checkout is disabled until the first two are set; the
  // webhook secret is required for /v1/billing/webhook to accept events.
  STRIPE_SECRET_KEY?: string;
  STRIPE_PRICE_PRO?: string;
  STRIPE_WEBHOOK_SECRET?: string;
}
