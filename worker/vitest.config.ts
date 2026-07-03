import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    // The Sandbox export (`export { Sandbox } from "@cloudflare/sandbox"` in
    // src/index.ts) pulls in `@cloudflare/containers`, which vitest-pool-workers'
    // default SSR module resolution can't import directly (see
    // https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/#module-resolution).
    // Bundling it via the SSR dep optimizer resolves the import.
    deps: {
      optimizer: {
        ssr: {
          enabled: true,
          include: ["@cloudflare/containers"],
        },
      },
    },
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        // Cloudflare Workflow instances created via `env.EMPLOYEE_CYCLE.create()`
        // cannot be automatically disposed under per-test isolated storage
        // (see https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/#isolated-storage).
        // Task 7's routes actually start Workflows, so isolated storage must be
        // disabled to avoid the "Workflows...must be manually disposed" failure.
        isolatedStorage: false,
        miniflare: {
          // Test-only values for bindings that are real secrets/resources in
          // production; real deployments set these via `npx wrangler secret put`
          // / `npx wrangler r2 bucket create` (see wrangler.toml comments).
          bindings: {
            DAZL_API_SECRET: "test-secret",
            CLAUDE_CODE_OAUTH_TOKEN: "test-token",
          },
          // Local R2 bucket simulation for BRAIN_REPO (the swamp brain repo
          // snapshot) so binding tests can run without a real R2 bucket.
          r2Buckets: ["BRAIN_REPO"],
        },
      },
    },
  },
});
