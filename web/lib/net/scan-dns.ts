// #1463 (prod run af02437c, 2026-11-22): during a live scan /app stayed on "Opening your workspace…" until the scan finished.
// The server's HTML and RSC payload were complete; the page never hydrated because its /_next/static chunks (served by this
// same Next process with fs reads) queued behind the scan. Node runs fs, async zlib and dns.lookup() on one libuv
// threadpool of 4 threads; dns.lookup() is getaddrinfo, which blocks its thread for the whole resolution, seconds for a slow or
// dead name. A crawl resolving many company hosts at once filled the pool, so every chunk read waited.
// Scan hosts are therefore resolved here with c-ares (dns.promises.Resolver): network queries on the event loop, no pool
// thread, with a per-query timeout, a bounded retry and a per-process cap on lookups in flight. /etc/hosts is not consulted,
// which is right for public company hosts (anything private or local is refused by the callers anyway).
import { promises as dnsPromises } from 'node:dns'
const { Resolver } = dnsPromises
import { isIP } from 'node:net'

export type Address = { address: string; family: number }

const TIMEOUT_MS = 2500
const TRIES = 2
export const SCAN_DNS_CONCURRENCY = 16

let shared: InstanceType<typeof Resolver> | null = null
function resolver(): InstanceType<typeof Resolver> {
  shared ??= new Resolver({ timeout: TIMEOUT_MS, tries: TRIES })
  return shared
}
// For a test that points the resolver at its own server (a silent one, to prove a dead name holds no pool thread).
export function setScanDnsServersForTest(servers: string[] | null): void {
  shared = null
  if (servers) { shared = new Resolver({ timeout: 200, tries: 1 }); shared.setServers(servers) }
}

let active = 0
const waiting: (() => void)[] = []
async function slot<T>(work: () => Promise<T>): Promise<T> {
  if (active >= SCAN_DNS_CONCURRENCY) await new Promise<void>(r => waiting.push(r))
  active++
  try { return await work() } finally { active--; waiting.shift()?.() }
}

const notFound = (e: unknown) => /ENODATA|ENOTFOUND|NXDOMAIN|ENONAME/.test(String((e as { code?: string })?.code ?? e))

// Every A and AAAA record for the host. Rejects (like dns.lookup) when the name has none or the queries fail.
export function scanLookupAll(hostname: string): Promise<Address[]> {
  // An IP literal is its own answer (dns.lookup returns it as is; c-ares would query it as a name). The callers' public-address checks still apply.
  const lit = hostname.replace(/^\[|\]$/g, ''), fam = isIP(lit)
  if (fam) return Promise.resolve([{ address: lit, family: fam }])
  return slot(async () => {
    const r = resolver()
    const [v4, v6] = await Promise.allSettled([r.resolve4(hostname), r.resolve6(hostname)])
    const out: Address[] = [
      ...(v4.status === 'fulfilled' ? v4.value.map((address: string) => ({ address, family: 4 })) : []),
      ...(v6.status === 'fulfilled' ? v6.value.map((address: string) => ({ address, family: 6 })) : []),
    ]
    if (out.length) return out
    const err = v4.status === 'rejected' ? v4.reason : v6.status === 'rejected' ? v6.reason : null
    const e = new Error(`scan dns: no address for ${hostname}`) as Error & { code: string }
    e.code = err && !notFound(err) ? String((err as { code?: string }).code ?? 'ESERVFAIL') : 'ENOTFOUND'
    throw e
  })
}

// dns.lookup's callback shape (all: true), for the connect-time guards that take a lookup function.
export function scanLookupCb(hostname: string, cb: (err: Error | null, addrs: Address[]) => void): void {
  scanLookupAll(hostname).then(a => cb(null, a), e => cb(e as Error, []))
}
