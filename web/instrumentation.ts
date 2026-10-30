// Runs once per server start. Returns this process's own running scans to 'pending' when the process exits so a deploy
// restart does not strand them behind the 20 min stale lease (see requeueInFlightForShutdown in lib/scan/runner.ts).
// Synchronous (process 'exit' event), own rows only, no network, no provider call. SIGKILL/crash still rely on the lease reaper.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { installShutdownRequeue } = await import('./lib/scan/shutdown-hook.ts')
  installShutdownRequeue()
  // Uncaught exceptions and unhandled rejections go through the scrubbed error monitor (lib/ops/process-errors.ts).
  const { recordProcessErrors } = await import('./lib/ops/process-errors.ts')
  recordProcessErrors()
}

// Every uncaught error from a route handler, page or server action (lib/ops/request-error.ts).
export async function onRequestError(err: unknown, request: { path: string; method: string; headers: Record<string, string | string[] | undefined> }, context: { routerKind?: string; routePath?: string; routeType?: string }) {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { handleRequestError } = await import('./lib/ops/request-error.ts')
  const { getSessionUser } = await import('./lib/auth-db.ts')
  await handleRequestError(err, request, context, { tenantFor: async t => (await getSessionUser(t))?.tenantId ?? null })
}
