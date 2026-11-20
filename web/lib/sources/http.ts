import https from 'node:https'
import { isIP } from 'node:net'
import { guardedLookup } from '../scan/fetch-page.ts'
import type { HttpResult, SafeGet } from './types.ts'

// HTTPS only, public addresses only (checked at connect time), no redirects, size and time capped.
const MAX_BYTES = 1_000_000
const TIMEOUT_MS = Number(process.env.SOURCES_TIMEOUT_MS || 10_000)

type SafeGetOptions = Parameters<SafeGet>[1]
export type ObservedHttpResult = Readonly<HttpResult & {
  finalUrl: string; contentType: string | null; contentEncoding: string | null; complete: boolean
}>
export type ObservedSafeGet = (rawUrl: string, opts?: { accept?: string; userAgent?: string; signal?: AbortSignal }) => Promise<ObservedHttpResult | null>

function makeRequest<T extends HttpResult>(timeoutMs: number, lookup: typeof guardedLookup, testAnyPort: boolean, opts: {
  maxBytes: number; strictUtf8?: boolean; freshConnection?: boolean
  project: (value: HttpResult, res: import('node:http').IncomingMessage, url: URL) => T
}) {
  return (rawUrl: string, options: SafeGetOptions = {}) => new Promise<T | null>(resolveRaw => {
    if (options.signal?.aborted) return resolveRaw(null)
    let url: URL
    try { url = new URL(rawUrl) } catch { return resolveRaw(null) }
    if (url.protocol !== 'https:' || url.username || url.password || (!testAnyPort && url.port && url.port !== '443')) return resolveRaw(null)
    const resolve = (v: T | null) => { clearTimeout(hard); resolveRaw(v) }
    const req = https.request(
      url,
      { method: 'GET', ...(opts.freshConnection?{agent:false as const}:{}), lookup: lookup as never, timeout: timeoutMs, signal: options.signal, headers: { 'user-agent': 'dazl-sources/1.0 (+https://dazl.ai)', accept: options.accept ?? '*/*', 'accept-encoding': 'identity', ...options.headers } },
      res => {
        const status = res.statusCode ?? 0
        const result = (value: HttpResult) => resolve(opts.project(value, res, url))
        if (status >= 300 && status < 400) { res.resume(); const loc = res.headers.location; return result(typeof loc === 'string' && loc ? { status, body: '', location: loc } : { status, body: '' }) }
        const chunks: Buffer[] = []
        let n = 0
        res.on('data', (c: Buffer) => {
          n += c.length
          if (n > opts.maxBytes) { result({ status, body: Buffer.concat(chunks).toString('utf8'), truncated: true }); res.destroy() } else chunks.push(c)
        })
        res.on('end', () => {
          const bytes = Buffer.concat(chunks)
          try { result({ status, body: opts.strictUtf8 ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : bytes.toString('utf8') }) }
          catch { resolve(null) }
        })
        res.on('error', () => resolve(null))
        res.on('close', () => resolve(null))
      },
    )
    const hard = setTimeout(() => { req.destroy(new Error('timeout')); resolve(null) }, timeoutMs)
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', () => resolve(null))
    req.end()
  })
}

// timeoutMs/lookup injectable for legacy tests. Absolute timer: the socket timeout is inactivity-only.
export const makeSafeGet = (timeoutMs = TIMEOUT_MS, lookup: typeof guardedLookup = guardedLookup, testAnyPort = false): SafeGet =>
  makeRequest(timeoutMs, lookup, testAnyPort, { maxBytes:MAX_BYTES, project:value=>value })

export const safeGet: SafeGet = makeSafeGet()

// New proof reads require transport-observed MIME and complete exact bytes;
// preserve the legacy SafeGet response shape and behavior for existing callers.
const observed = makeRequest(8_000, guardedLookup, false, {
  maxBytes:128_000, strictUtf8:true, freshConnection:true,
  project(value,res,url): ObservedHttpResult {
    const type = res.headersDistinct['content-type'], coding = res.headersDistinct['content-encoding']
    return Object.freeze({ ...value, finalUrl:url.href,
      contentType:type?.length===1?type[0]:null, contentEncoding:coding===undefined?'identity':coding.length===1?coding[0]:null,
      complete:res.complete && !value.truncated && (value.status<300 || value.status>=400) })
  },
})
export const observedSafeGet: ObservedSafeGet = (raw, opts) => {
  // https.request skips lookup for IP literals. Never let those, private-name
  // suffixes or alias/URL parsing variants access this new proof transport.
  let url: URL
  try { url=new URL(raw) } catch { return Promise.resolve(null) }
  if (url.href!==raw || isIP(url.hostname.replace(/^\[|\]$/g,'')) || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(url.hostname) ||
      /\.(?:localhost|local|internal|onion|test|invalid)$/i.test(url.hostname)) return Promise.resolve(null)
  return observed(raw, { signal:opts?.signal, accept:opts?.accept, headers:opts?.userAgent?{'user-agent':opts.userAgent}:undefined })
}
