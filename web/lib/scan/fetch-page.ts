import { lookup as dnsLookup } from 'node:dns'
import https from 'node:https'
import { isIP } from 'node:net'

export interface Page { text: string; title: string; retrievedAt: number }

// True only for addresses on the public internet. Everything private, loopback,
// link-local, cloud-metadata, CGNAT, multicast or reserved is refused.
export function isPublicIp(ip: string): boolean {
  const v = isIP(ip)
  if (v === 4) {
    const [a, b, c] = ip.split('.').map(Number)
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false
    if (a === 169 && b === 254) return false
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 192 && b === 168) return false
    if (a === 100 && b >= 64 && b <= 127) return false
    if (a === 192 && b === 0 && c === 0) return false
    if (a === 198 && (b === 18 || b === 19)) return false
    return true
  }
  if (v === 6) {
    const x = ip.toLowerCase()
    const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped) return isPublicIp(mapped[1])
    if (x === '::' || x === '::1') return false
    if (/^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith('ff')) return false
    return true
  }
  return false
}

// Checked at connect time on the address actually used, so DNS rebinding cannot swap in a private IP.
function guardedLookup(hostname: string, options: { all?: boolean }, cb: (...args: unknown[]) => void) {
  dnsLookup(hostname, { all: true }, (err, addrs) => {
    if (err) return cb(err)
    if (addrs.length === 0 || addrs.some(a => !isPublicIp(a.address))) return cb(new Error('blocked_address'))
    if (options?.all) return cb(null, addrs)
    cb(null, addrs[0].address, addrs[0].family)
  })
}

const MAX_BYTES = 1_500_000
const MAX_REDIRECTS = 3
const TIMEOUT_MS = Number(process.env.SCAN_PAGE_TIMEOUT_MS || 10_000)

function once(url: URL): Promise<{ status: number; location?: string; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      { method: 'GET', lookup: guardedLookup as never, timeout: TIMEOUT_MS, headers: { 'user-agent': 'dazl-evidence-check/1.0', accept: 'text/html,text/plain;q=0.9', 'accept-encoding': 'identity' } },
      res => {
        const status = res.statusCode ?? 0
        const type = String(res.headers['content-type'] ?? '')
        if (status >= 300 && status < 400) {
          res.resume()
          return resolve({ status, location: String(res.headers.location ?? ''), type, body: '' })
        }
        if (!/^text\/(html|plain)|application\/xhtml/i.test(type)) {
          res.destroy()
          return resolve({ status, type, body: '' })
        }
        const chunks: Buffer[] = []
        let n = 0
        res.on('data', (c: Buffer) => {
          n += c.length
          if (n > MAX_BYTES) { res.destroy(); resolve({ status, type, body: Buffer.concat(chunks).toString('utf8') }) } else chunks.push(c)
        })
        res.on('end', () => resolve({ status, type, body: Buffer.concat(chunks).toString('utf8') }))
        res.on('error', reject)
      },
    )
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end()
  })
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
function decode(s: string): string {
  return s
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_, e: string) => {
      if (e[0] === '#') {
        const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
        return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : ' '
      }
      return ENT[e.toLowerCase()] ?? ' '
    })
}

export function htmlToText(html: string): { text: string; title: string } {
  const title = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '')
  const text = decode(
    html
      .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim()
  return { text, title: title.replace(/\s+/g, ' ').trim().slice(0, 300) }
}

// Fetches a public https page. Returns null on any refusal or failure.
export async function safeFetchPage(rawUrl: string): Promise<Page | null> {
  try {
    let url = new URL(rawUrl)
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null
      const host = url.hostname.replace(/^\[|\]$/g, '')
      if (isIP(host) && !isPublicIp(host)) return null
      const r = await once(url)
      if (r.status >= 300 && r.status < 400) {
        if (!r.location) return null
        url = new URL(r.location, url)
        continue
      }
      if (r.status < 200 || r.status >= 300 || !r.body) return null
      const { text, title } = htmlToText(r.body)
      return text ? { text, title, retrievedAt: Math.floor(Date.now() / 1000) } : null
    }
    return null
  } catch {
    return null
  }
}
