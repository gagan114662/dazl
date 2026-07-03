import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        // Cloudflare Workflow instances created via `env.EMPLOYEE_CYCLE.create()`
        // cannot be automatically disposed under per-test isolated storage
        // (see https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/#isolated-storage).
        // Task 7's routes actually start Workflows, so isolated storage must be
        // disabled to avoid the "Workflows...must be manually disposed" failure.
        isolatedStorage: false,
      },
    },
  },
});
