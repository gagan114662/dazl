// Global test fence, loaded via --import in the npm test script so it runs
// before any test file (and before any lib module it pulls in).
//
// 1) Secret scrub: synthetic tests must never see real credentials. Any
//    inherited env var whose name carries KEY/SECRET/TOKEN/PASSWORD is
//    deleted; tests set their own dummy values explicitly after this runs.
//    This is what makes "no provider calls in tests" enforceable instead of
//    aspirational: even if a code path reached a provider endpoint, there is
//    no key in the environment to authenticate (or bill) with.
for (const name of Object.keys(process.env)) {
  if (/(KEY|SECRET|TOKEN|PASSWORD)/.test(name)) delete process.env[name]
}

// 2) Network fence: synthetic tests must not attempt real outbound
//    connections at all - not provider APIs, not lead/company websites
//    (sitecrawl), not evidence fetches. Anything but loopback throws, so a
//    missing stub fails the test loudly instead of silently depending on the
//    network (or hanging against a dead one).
import http from 'node:http'
import https from 'node:https'

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'])

function hostOf(input: unknown): string | null {
  try {
    if (typeof input === 'string' || input instanceof URL) return new URL(String(input)).hostname
    if (input instanceof Request) return new URL(input.url).hostname
    if (input && typeof input === 'object') {
      const o = input as { hostname?: string; host?: string }
      const h = o.hostname ?? o.host
      if (h) return h.split(':')[0]
    }
  } catch { /* fall through */ }
  return null
}

function assertLoopback(input: unknown, via: string): void {
  const h = hostOf(input)
  if (!h || !LOOPBACK.has(h)) {
    throw new Error(`test net fence: blocked ${via} to ${h ?? String(input)} - stub the network in the test instead`)
  }
}

const realFetch = globalThis.fetch
globalThis.fetch = ((input: unknown, init?: RequestInit) => {
  assertLoopback(input, 'fetch')
  return realFetch(input as never, init)
}) as typeof fetch

for (const [mod, name] of [[http, 'http'], [https, 'https']] as const) {
  for (const method of ['request', 'get'] as const) {
    const orig = mod[method] as (url: unknown, ...rest: unknown[]) => unknown
    ;(mod as Record<string, unknown>)[method] = (url: unknown, ...rest: unknown[]) => {
      assertLoopback(url, `${name}.${method}`)
      return orig(url, ...rest)
    }
  }
}
