import { lookup as dnsLookup } from 'node:dns/promises'

// Fetches a page the user gave us (their own site, for the ICP-from-website feature).
// SSRF protection: only public hosts, every redirect hop re-validated, hard size and
// time caps. The fetched content is data, never instructions - callers treat it as
// untrusted text. Robots/ToS: this is the user's own site, fetched at their request.

export type PublicFetchError = 'invalid' | 'not_public' | 'blocked' | 'timeout' | 'not_html'

const MAX_BYTES = 512 * 1024
const MAX_REDIRECTS = 3
const TIMEOUT_MS = 8_000

export type Lookup = (hostname: string) => Promise<{ address: string; family: number }[]>
const defaultLookup: Lookup = (hostname) => dnsLookup(hostname, { all: true, verbatim: true })

// Loopback, private, link-local (cloud metadata), CGNAT, multicast, documentation and
// other non-public ranges. Anything we do not recognize as plainly public is rejected.
export function isPublicIp(ip: string): boolean {
  let v = ip.trim().toLowerCase()
  if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1)
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(v)
  if (mapped) v = mapped[1]
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) {
    const parts = v.split('.').map(Number)
    if (parts.some(n => n > 255)) return false
    const [a, b] = parts
    if (a === 0 || a === 10 || a === 127) return false                       // unspecified, private, loopback
    if (a === 169 && b === 254) return false                                 // link-local (cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return false                        // private
    if (a === 192 && b === 168) return false                                 // private
    if (a === 192 && b === 0 && (parts[2] === 0 || parts[2] === 2)) return false // IETF assignments + doc range
    if (a === 198 && (b === 18 || b === 19)) return false                    // benchmark
    if (a === 198 && b === 51 && parts[2] === 100) return false              // doc range
    if (a === 203 && b === 0 && parts[2] === 113) return false               // doc range
    if (a === 100 && b >= 64 && b <= 127) return false                       // CGNAT
    if (a >= 224) return false                                               // multicast / reserved
    return true
  }
  if (!v.includes(':')) return false
  if (v === '::' || v === '::1') return false
  if (v.startsWith('64:ff9b:')) return false                                 // NAT64
  if (v.startsWith('2001:db8:')) return false                                // documentation
  const h = parseInt(v.split(':')[0] || '0', 16)
  if ((h & 0xffc0) === 0xfe80) return false                                  // link-local
  if ((h & 0xfe00) === 0xfc00) return false                                  // unique local
  return true
}

const isIpLiteral = (host: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')

async function resolvePublic(host: string, lookup: Lookup): Promise<boolean> {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  if (isIpLiteral(bare)) return isPublicIp(bare)
  let records: { address: string }[]
  try { records = await lookup(bare) } catch { return false }
  // Every resolved address must be public: a round-robin record with one private
  // answer is a rebinding attack, not a website.
  return records.length > 0 && records.every(r => isPublicIp(r.address))
}

export interface PublicFetchDeps { fetchImpl?: typeof fetch; lookup?: Lookup }

export async function fetchPublicHtml(rawUrl: string, deps: PublicFetchDeps = {}): Promise<{ html: string; finalUrl: string } | { error: PublicFetchError }> {
  const f = deps.fetchImpl ?? fetch
  const lookup = deps.lookup ?? defaultLookup
  let url: URL
  try { url = new URL(rawUrl.trim()) } catch { return { error: 'invalid' } }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { error: 'invalid' }
  if (url.username || url.password) return { error: 'invalid' }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!(await resolvePublic(url.hostname, lookup))) return { error: 'not_public' }
    let res: Response
    try {
      res = await f(url.toString(), {
        redirect: 'manual', // we follow by hand and re-validate every hop
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'user-agent': 'dazl-icp/1.0 (+https://dazl.ai)', accept: 'text/html,application/xhtml+xml' },
      })
    } catch (e) {
      const name = e instanceof Error ? e.name : ''
      return { error: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'blocked' }
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (!loc) return { error: 'blocked' }
      try { url = new URL(loc, url) } catch { return { error: 'invalid' } }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return { error: 'invalid' }
      continue
    }
    if (!res.ok) return { error: 'blocked' }
    const type = res.headers.get('content-type') ?? ''
    if (type && !/text\/html|application\/xhtml/i.test(type)) return { error: 'not_html' }
    // Size cap: read at most MAX_BYTES and keep that prefix (a huge page still yields a profile).
    let html: string
    if (res.body) {
      const reader = res.body.getReader()
      const chunks: Uint8Array[] = []
      let total = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          total += value.byteLength
          chunks.push(value)
          if (total >= MAX_BYTES) { await reader.cancel().catch(() => {}); break }
        }
      } catch { return { error: 'timeout' } }
      const buf = new Uint8Array(Math.min(total, MAX_BYTES))
      let off = 0
      for (const c of chunks) { const n = Math.min(c.byteLength, buf.byteLength - off); buf.set(c.subarray(0, n), off); off += n }
      html = new TextDecoder().decode(buf)
    } else {
      html = (await res.text()).slice(0, MAX_BYTES)
    }
    return { html, finalUrl: url.toString() }
  }
  return { error: 'blocked' } // redirect loop
}
