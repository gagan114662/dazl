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
// DSN-style secrets the name regex misses (credentials live inside the URL).
// Under the fenced harness the live-PG contract test skips; an intentional
// rehearsal runs that file directly (node --test test/leads-read-pg-live.test.ts)
// with DAZL_PG_ADMIN set explicitly - outside this harness, still loopback-only
// and marker-guarded by scripts/pg-migrate/guard.ts.
for (const name of ['DAZL_PG_ADMIN', 'DATABASE_URL']) delete process.env[name]

// 2) Network fence: synthetic tests must not attempt real outbound
//    connections at all - not provider APIs, not lead/company websites
//    (sitecrawl), not evidence fetches. Anything but loopback throws, so a
//    missing stub fails the test loudly instead of silently depending on the
//    network (or hanging against a dead one, which is how the mixed-mode
//    regression initially presented).
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'

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

// Raw-socket layer: a direct net/tls connect must not bypass the HTTP-layer
// guards above. connect/createConnection take (options | port, host?, ...).
function netHost(args: unknown[]): string {
  const [a, b] = args
  if (typeof a === 'number') return typeof b === 'string' ? b : 'localhost'
  return hostOf(a) ?? 'unknown'
}
for (const [mod, name, methods] of [
  [net, 'net', ['connect', 'createConnection']],
  [tls, 'tls', ['connect']],
] as const) {
  for (const method of methods) {
    const orig = (mod as Record<string, (...a: unknown[]) => unknown>)[method]
    ;(mod as Record<string, (...a: unknown[]) => unknown>)[method] = (...args: unknown[]) => {
      assertLoopback(netHost(args), `${name}.${method}`)
      return orig(...args)
    }
  }
}

// KNOWN LIMITS (review must read these; this fence is a strong default, not a
// proof that no test can ever egress or bill):
// - DNS: hostname checks happen before resolution; dns.lookup itself still
//   reaches the configured resolver (egress class: resolver query only).
// - Redirects: fetch to an ALLOWED loopback server that answers 30x to an
//   external URL is followed by undici. Tests must not do that; the fence
//   cannot see the redirect target before following.
// - Direct undici imports (import { request } from 'undici'), dgram/UDP, and
//   child_process-spawned network tools are not wrapped.
// - The env scrub covers process env only and matches KEY/SECRET/TOKEN/
//   PASSWORD plus the explicit DSN list; it cannot enumerate every possible
//   credential name, and credential FILES on disk (~/.ssh, .env, cloud cred
//   files) are out of scope. The suite runs from web/ and lib code under
//   node --test does not load dotenv.
// - Loopback is allowed by design (tests run local servers); the PG live
//   contract test's own guard stack (loopback-only, fresh dazl_rehearse_* DB,
//   ownership-marker token, per-run non-superuser role) is what bounds it,
//   and its admin DSN is scrubbed here so it can never fire accidentally
//   under npm test.
