import https from 'node:https'
import { guardedLookup } from '../scan/fetch-page.ts'
import type { HttpResult, SafeGet } from './types.ts'

// HTTPS only, public addresses only (checked at connect time), no redirects, size and time capped.
const MAX_BYTES = 1_000_000
const TIMEOUT_MS = Number(process.env.SOURCES_TIMEOUT_MS || 10_000)

export const safeGet: SafeGet = (rawUrl, opts = {}) =>
  new Promise<HttpResult | null>(resolve => {
    let url: URL
    try { url = new URL(rawUrl) } catch { return resolve(null) }
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return resolve(null)
    const req = https.request(
      url,
      { method: 'GET', lookup: guardedLookup as never, timeout: TIMEOUT_MS, headers: { 'user-agent': 'dazl-sources/1.0 (+https://dazl.ai)', accept: opts.accept ?? '*/*', 'accept-encoding': 'identity', ...opts.headers } },
      res => {
        const status = res.statusCode ?? 0
        if (status >= 300 && status < 400) { res.resume(); return resolve({ status, body: '' }) }
        const chunks: Buffer[] = []
        let n = 0
        res.on('data', (c: Buffer) => {
          n += c.length
          if (n > MAX_BYTES) { res.destroy(); resolve({ status, body: Buffer.concat(chunks).toString('utf8') }) } else chunks.push(c)
        })
        res.on('end', () => resolve({ status, body: Buffer.concat(chunks).toString('utf8') }))
        res.on('error', () => resolve(null))
      },
    )
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', () => resolve(null))
    req.end()
  })
