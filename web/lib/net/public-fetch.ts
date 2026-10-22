import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'

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
  // Only global unicast IPv6, excluding transition and special-purpose space.
  if (isIP(v) !== 6) return false
  const first = parseInt(v.split(':')[0], 16)
  if (!Number.isFinite(first) || first < 0x2000 || first > 0x3fff) return false
  if (/^2001:(?:0{1,4}|0?db8|[12][0-9a-f]{2}):/i.test(v)) return false
  if (first === 0x2002) return false // 6to4 embeds an IPv4 destination
  return true
}

export type PublicAddress = { address: string; family: number }
export async function resolvePublic(host: string, lookup: Lookup): Promise<PublicAddress[] | null> {
  const bare = host.replace(/^\[|\]$/g, '')
  const family = isIP(bare)
  if (family) return isPublicIp(bare) ? [{ address: bare, family }] : null
  let records: PublicAddress[]
  try { records = await lookup(bare) } catch { return null }
  return records.length > 0 && records.every(r => isPublicIp(r.address)) ? records : null
}

// Crucial: the TCP connection uses ONLY the validated address. Host and TLS SNI stay
// the original hostname, but there is no second DNS lookup (no rebinding window).
export function pinnedLookup(address: PublicAddress): import('node:net').LookupFunction {
  return (_hostname, options, cb) => {
    if (options.all) cb(null, [address])
    else cb(null, address.address, address.family)
  }
}

export function pinnedHtmlRequest(url: URL, records: PublicAddress[], signal: AbortSignal): Promise<Response> {
  return new Promise((resolve, reject) => {
    const address = records[0]
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest
    const req = request(url, {
      agent: false,
      signal,
      lookup: pinnedLookup(address),
      headers: { 'user-agent': 'dazl-icp/1.0 (+https://dazl.ai)', accept: 'text/html,application/xhtml+xml' },
    }, res => {
      const headers = new Headers()
      for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v)
      const chunks: Buffer[] = []
      let total = 0
      let finished = false
      const finish = () => {
        if (finished) return
        finished = true
        const status = res.statusCode ?? 502
        resolve(new Response(status === 204 || status === 304 ? null : Buffer.concat(chunks, total), { status, headers }))
      }
      if ((res.statusCode ?? 0) >= 300 && (res.statusCode ?? 0) < 400) { finish(); res.destroy(); return }
      res.on('data', (chunk: Buffer) => {
        const part = chunk.subarray(0, MAX_BYTES - total)
        chunks.push(part); total += part.length
        if (total >= MAX_BYTES) { finish(); res.destroy() }
      })
      res.on('end', finish)
      res.on('error', e => { if (!finished) reject(e) })
    })
    req.on('error', reject)
    req.end()
  })
}

export interface PublicFetchDeps { fetchImpl?: typeof fetch; lookup?: Lookup }

export async function fetchPublicHtml(rawUrl: string, deps: PublicFetchDeps = {}): Promise<{ html: string; finalUrl: string } | { error: PublicFetchError }> {
  const deadline = AbortSignal.timeout(TIMEOUT_MS)
  const lookup = deps.lookup ?? defaultLookup
  let url: URL
  try { url = new URL(rawUrl.trim()) } catch { return { error: 'invalid' } }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { error: 'invalid' }
  if (url.username || url.password) return { error: 'invalid' }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (url.username || url.password || (url.port && url.port !== '80' && url.port !== '443')) return { error: 'invalid' }
    let records: PublicAddress[] | null
    try {
      records = await Promise.race([
        resolvePublic(url.hostname, lookup),
        new Promise<never>((_, reject) => { if (deadline.aborted) reject(new Error('timeout')); else deadline.addEventListener('abort', () => reject(new Error('timeout')), { once: true }) }),
      ])
    } catch { return { error: 'timeout' } }
    if (!records) return { error: 'not_public' }
    let res: Response
    try {
      res = deps.fetchImpl ? await deps.fetchImpl(url.toString(), {
        redirect: 'manual', // we follow by hand and re-validate every hop
        signal: deadline,
        headers: { 'user-agent': 'dazl-icp/1.0 (+https://dazl.ai)', accept: 'text/html,application/xhtml+xml' },
      }) : await pinnedHtmlRequest(url, records, deadline)
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
          const part = value.subarray(0, MAX_BYTES - total)
          total += part.byteLength
          chunks.push(part)
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
