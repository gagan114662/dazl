// Which app instance answered, and which store it was configured for, for /api/health and /api/ready. With several
// instances behind one address, a health check names the one that served it.
//   instance: DAZL_INSTANCE_ID when set (letters, digits, . _ - only, at most 64), else a random id made once per process.
//             Never the host name or the pid, so the public body says nothing about the machine.
//   db:       'postgres' when DATABASE_URL is set, else 'sqlite': the store getDb() opens (lib/db/client.ts). Read from
//             the configuration, not the store, so liveness never waits on the database.
import { randomBytes } from 'node:crypto'

let generated: string | undefined
export function instanceId(env: Record<string, string | undefined> = process.env): string {
  const set = env.DAZL_INSTANCE_ID
  if (set && /^[A-Za-z0-9._-]{1,64}$/.test(set)) return set
  return generated ??= randomBytes(6).toString('hex')
}

export function dbBackend(env: Record<string, string | undefined> = process.env): 'postgres' | 'sqlite' {
  return env.DATABASE_URL ? 'postgres' : 'sqlite'
}
