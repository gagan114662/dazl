// next/headers for test/helpers/pg-session-loader.mjs: cookies() is the jar of the request being handled (withJar), so
// two requests in flight in one process never see each other's cookies. A route's set/delete changes that jar, as the
// browser would apply Set-Cookie.
import { AsyncLocalStorage } from 'node:async_hooks'

export type Jar = Map<string, string>
const current = new AsyncLocalStorage<Jar>()
export function withJar<T>(jar: Jar, fn: () => Promise<T>): Promise<T> { return current.run(jar, fn) }

export async function cookies() {
  const jar = current.getStore()
  if (!jar) throw new Error('cookies() outside a request')
  return {
    get: (name: string) => jar.has(name) ? { name, value: jar.get(name)! } : undefined,
    set: (name: string, value: string) => { jar.set(name, value) },
    delete: (name: string) => { jar.delete(name) },
  }
}
export async function headers() { return new Headers() }
