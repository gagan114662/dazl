// Runs once per server start. Returns this process's own running scans to 'pending' on SIGTERM so a deploy
// restart does not strand them behind the 20 min stale lease (see requeueInFlightForShutdown in lib/scan/runner.ts).
// Synchronous, own rows only, no network, no provider call. SIGKILL/crash still rely on the lease reaper.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { installShutdownRequeue } = await import('./lib/scan/shutdown-hook.ts')
  installShutdownRequeue()
}
