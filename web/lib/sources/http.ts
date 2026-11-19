import https from 'node:https'
import { isIP } from 'node:net'
import { isPublicIp } from '../net/public-fetch.ts'
import { guardedLookup } from '../scan/fetch-page.ts'
import type { HttpResult, SafeGet } from './types.ts'

// HTTPS only, public addresses only (checked at connect time), no redirects, size and time capped.
const MAX_BYTES = 1_000_000
const TIMEOUT_MS = Number(process.env.SOURCES_TIMEOUT_MS || 10_000)

// Hostnames also require the existing guarded DNS lookup at connect time.
export function publicSourceHttps(url: URL, testAnyPort = false): boolean {
  if (url.protocol !== 'https:' || url.username || url.password || (!testAnyPort && url.port && url.port !== '443')) return false
  // Node bypasses DNS lookup for literal IPs. Only the explicit nonstandard-port
  // in-process fixture can bypass this check.
  const host = url.hostname.replace(/^\[|\]$/g, '')
  return !!(testAnyPort && url.port && url.port !== '443') || !isIP(host) || isPublicIp(host)
}

// timeoutMs/lookup injectable for tests. Absolute timer: the socket timeout is inactivity-only.
export const makeSafeGet = (timeoutMs = TIMEOUT_MS, lookup: typeof guardedLookup = guardedLookup, testAnyPort = false): SafeGet => (rawUrl, opts = {}) =>
  new Promise<HttpResult | null>(resolveRaw => {
    if (opts.signal?.aborted) return resolveRaw(null)
    let url: URL
    try { url = new URL(rawUrl) } catch { return resolveRaw(null) }
    if (!publicSourceHttps(url, testAnyPort)) return resolveRaw(null)
    const resolve = (v: HttpResult | null) => { clearTimeout(hard); resolveRaw(v) }
    const req = https.request(
      url,
      { method: 'GET', lookup: lookup as never, timeout: timeoutMs, signal: opts.signal, headers: { 'user-agent': 'dazl-sources/1.0 (+https://dazl.ai)', accept: opts.accept ?? '*/*', 'accept-encoding': 'identity', ...opts.headers } },
      res => {
        const status = res.statusCode ?? 0
        if (status >= 300 && status < 400) { res.resume(); const loc = res.headers.location; return resolve(typeof loc === 'string' && loc ? { status, body: '', location: loc } : { status, body: '' }) }
        const chunks: Buffer[] = []
        let n = 0
        res.on('data', (c: Buffer) => {
          n += c.length
          if (n > MAX_BYTES) { res.destroy(); resolve({ status, body: Buffer.concat(chunks).toString('utf8'), truncated: true }) } else chunks.push(c)
        })
        res.on('end', () => resolve({ status, body: Buffer.concat(chunks).toString('utf8') }))
        res.on('error', () => resolve(null))
        res.on('close', () => resolve(null)) // no-op once already settled
      },
    )
    const hard = setTimeout(() => { req.destroy(new Error('timeout')); resolve(null) }, timeoutMs)
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', () => resolve(null))
    req.end()
  })

export const safeGet: SafeGet = makeSafeGet()
