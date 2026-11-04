// Operator surface for runtime workers (docs/design/runtime-workers.md). Runs on the host with the app's store
// (DB_PATH, or DATABASE_URL for Postgres); not reachable from the web app. Every change and every refusal is recorded in
// worker_events with the actor op:<os login>, the worker name, version and code hash.
//
//   cd web && node --experimental-strip-types scripts/workers.mts <command> [args]
//     list                                        reviewed modules in this build (pinned hashes) and the deployments
//     register <name> <version> <sha256>          catalog a reviewed version; the hash must match the pin and the file
//     start <name> <version>                      first deployment of a registered, runnable version
//     stop <name> [--fence] [--drain-seconds N]   drain (default) or fence in-flight work
//     restart <name>                              fence and run the active version again, crash counters reset
//     upgrade <name> <version>                    switch to a newer registered version (same stateVersion)
//     rollback <name> <version>                   switch back to an older registered version (same stateVersion)
//     limits <name> [--max-in-flight N] [--per-tenant N] [--backlog N] [--attempts N]
//     grant <tenant id> <name>                    per-tenant allowlist (also written to the tenant's audit trail)
//     revoke <tenant id> <name>
//     events [name]                               the lifecycle trail
//     host [--instance ID] [--concurrency N]      run a worker host until SIGINT/SIGTERM
import { userInfo, hostname } from 'node:os'
import { getDb } from '../lib/db/client.ts'
import { fileHash } from '../lib/workers/definition.ts'
import { REVIEWED } from '../lib/workers/registry.ts'
import { runHost, WorkerHost } from '../lib/workers/runtime.ts'
import { activate, deployments, events, grant, register, restart, revoke, setLimits, start, stop, WorkerError } from '../lib/workers/store.ts'

const [cmd, ...rest] = process.argv.slice(2)
// positional arguments come first; flags (--x value, or --fence) follow them
const firstFlag = rest.findIndex(a => a.startsWith('--'))
const pos = firstFlag < 0 ? rest : rest.slice(0, firstFlag)
const flag = (n: string) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined }
const int = (n: string) => { const v = flag(n); return v === undefined ? undefined : /^\d{1,6}$/.test(v) ? Number(v) : NaN }
const actor = `op:${userInfo().username}`.replace(/[^A-Za-z0-9:._@-]/g, '_').slice(0, 80)

const db = await getDb()
const print = (v: unknown) => console.log(JSON.stringify(v, null, 2))
let code = 0
try {
  switch (cmd) {
    case 'list':
      print({
        reviewed: [...REVIEWED.values()].map(e => ({ name: e.module.definition.name, version: e.module.definition.version, effect: e.module.definition.effect, pinned: e.sha256, onDisk: fileHash(e) })),
        deployments: await deployments(db),
      })
      break
    case 'register': print(await register(db, actor, { name: pos[0], version: pos[1], codeHash: pos[2] }, REVIEWED)); break
    case 'start': print(await start(db, actor, pos[0], pos[1])); break
    case 'stop': print(await stop(db, actor, pos[0], { mode: rest.includes('--fence') ? 'fence' : 'drain', drainSeconds: int('drain-seconds') })); break
    case 'restart': print(await restart(db, actor, pos[0])); break
    case 'upgrade': print(await activate(db, actor, pos[0], pos[1], 'upgrade')); break
    case 'rollback': print(await activate(db, actor, pos[0], pos[1], 'rollback')); break
    case 'limits': {
      const l = { maxInFlight: int('max-in-flight'), perTenantInFlight: int('per-tenant'), maxBacklog: int('backlog'), maxAttempts: int('attempts') }
      print(await setLimits(db, actor, pos[0], Object.fromEntries(Object.entries(l).filter(([, v]) => v !== undefined))))
      break
    }
    case 'grant': print(await grant(db, actor, pos[0], pos[1])); break
    case 'revoke': print(await revoke(db, actor, pos[0], pos[1])); break
    case 'events': print(await events(db, { name: pos[0] })); break
    case 'host': {
      const ac = new AbortController()
      for (const s of ['SIGINT', 'SIGTERM'] as const) process.once(s, () => ac.abort())
      const instance = (flag('instance') ?? `${hostname()}:${process.pid}`).replace(/[^A-Za-z0-9:._@-]/g, '_').slice(0, 60)
      await runHost(new WorkerHost(db, { registry: REVIEWED, instance }), { concurrency: int('concurrency') ?? 2, signal: ac.signal })
      break
    }
    default:
      console.error('usage: workers.mts list|register|start|stop|restart|upgrade|rollback|limits|grant|revoke|events|host (see the header)')
      code = 2
  }
} catch (e) {
  console.error(e instanceof WorkerError ? `refused: ${e.message}` : e instanceof Error ? e.message : 'failed')
  code = 1
} finally {
  await db.close()
}
process.exit(code)
