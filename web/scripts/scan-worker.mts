// The scan worker process (#836): node --experimental-strip-types --no-warnings scripts/scan-worker.mts, from web/.
// A second process beside the app that takes scans from the shared work queue. lib/scan/worker.ts has the loop, what
// it does and does not do, and how it stops. Same env file and the same DB_PATH as the app; no port.
//   DAZL_SCAN_SHARED_QUEUE=1   required to do anything; otherwise the worker idles (it says so once)
//   SCAN_WORKER_ID             this worker's name: claimed_by and the journal say worker-<name>; default 8 random hex
//   SCAN_WORKER_CONCURRENCY    scans at once, 1 to 8, default 1
//   SCAN_WORKER_INTERVAL_MS    how often it looks for work, 250 to 60000, default 5000
import { scanWorkerMain } from '../lib/scan/worker.ts'

scanWorkerMain()
