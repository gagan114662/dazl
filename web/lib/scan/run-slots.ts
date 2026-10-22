// Shared in-process concurrency budget for scan execution. BOTH the legacy
// runner loop and the queue bridge consume from this one counter, so mixed
// tenant mode (some tenants on the queue, some legacy) can NEVER exceed
// SCAN_MAX_CONCURRENT in total - separate counters would silently double the
// provider/host exposure ceiling.
// Scope: in-process only. Today's inventory is one Node process; a future
// multi-worker setup needs a durable global bound, which this is not.
let active = 0
export function maxConcurrent(): number { return Number(process.env.SCAN_MAX_CONCURRENT || 3) }
export function slotAvailable(): boolean { return active < maxConcurrent() }
export function acquireSlot(): void { active++ }
export function releaseSlot(): void { active-- }
