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

// Redirects are followed hop by hop with the fence applied to EVERY target:
// reviewer-confirmed bypass at a926176 was an allowed loopback server 30x-ing
// to a denied host and undici following it unchecked. Semantics are preserved
// per the fetch spec: 301/302 rewrite POST to GET, 303 rewrites anything but
// GET/HEAD to GET (body and content-* headers dropped), 307/308 preserve
// method and body. Caller redirect modes are honored: 'manual' passes through
// untouched, 'error' rejects on a redirect status. Hop cap 10.
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECT_HOPS = 10
const realFetch = globalThis.fetch

function stripContentHeaders(headers: Headers): void {
  for (const h of ['content-type', 'content-length', 'content-encoding']) headers.delete(h)
}

globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  assertLoopback(input, 'fetch')
  const mode = init?.redirect ?? 'follow'
  if (mode === 'manual') return realFetch(input as never, init)
  const req = input instanceof Request ? input : new Request(input as never, init)
  if (mode === 'error') {
    const res = await realFetch(req, { redirect: 'manual' })
    if (REDIRECT_STATUSES.has(res.status)) throw new TypeError('fetch failed (redirect mode: error)')
    return res
  }
  // Snapshot the body BEFORE the first send: a sent request's body is
  // consumed, so 307/308 replay is only possible from a snapshot.
  let method = req.method
  const headers = new Headers(req.headers)
  let body: string | null = null
  if (method !== 'GET' && method !== 'HEAD' && req.body !== null) {
    if (req.bodyUsed) throw new Error('test net fence: cannot replay a consumed/streaming body across redirects')
    body = await req.text()
  }
  let url = req.url
  for (let hop = 0; ; hop++) {
    assertLoopback(url, 'fetch redirect hop')
    const current = new Request(url, { method, headers, body, signal: req.signal })
    const res = await realFetch(current, { redirect: 'manual' })
    if (!REDIRECT_STATUSES.has(res.status)) return res
    const loc = res.headers.get('location')
    if (!loc) return res
    if (hop >= MAX_REDIRECT_HOPS) throw new Error(`test net fence: fetch redirect hop cap (${MAX_REDIRECT_HOPS}) exceeded`)
    const next = new URL(loc, url).toString()
    assertLoopback(next, 'fetch redirect target')
    void res.body?.cancel().catch(() => { /* drain best-effort */ })
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
      method = 'GET'
      body = null
      stripContentHeaders(headers)
    }
    url = next
  }
}) as typeof fetch
;(globalThis as Record<string, unknown>).__DAZL_NET_FENCE__ = true

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
    const m = mod as unknown as Record<string, (...a: unknown[]) => unknown>
    const orig = m[method]
    m[method] = (...args: unknown[]) => {
      // netHost returns a bare host (not a URL), so check membership directly
      // - assertLoopback would URL-parse it and fail closed on every call.
      const h = netHost(args)
      if (!LOOPBACK.has(h)) {
        throw new Error(`test net fence: blocked ${name}.${method} to ${h} - stub the network in the test instead`)
      }
      return orig(...args)
    }
  }
}

// KNOWN LIMITS (review must read these; this fence is a strong default, not a
// proof that no test can ever egress or bill):
// - DNS: hostname checks happen before resolution; dns.lookup itself still
//   reaches the configured resolver (egress class: resolver query only).
// - Direct undici imports (import { request/fetch } from 'undici') and custom
//   dispatchers/Agents, dgram/UDP, and child_process-spawned network tools
//   are not wrapped.
// - Responses from followed redirects report .redirected === false (each hop
//   is a fresh manual request); hop cap is 10.
// - This is a strong default, NOT a universal no-network / no-billing proof:
//   a determined or accidental bypass via the paths above remains possible.
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
