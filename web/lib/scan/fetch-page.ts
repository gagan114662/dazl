import { lookup as dnsLookup } from 'node:dns'
import https from 'node:https'
import { isIP } from 'node:net'

export interface Page { text: string; title: string; retrievedAt: number; published?: string | null } // published: the page's OWN publication metadata (never modified/updated), YYYY-MM-DD

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
export function guardedLookup(hostname: string, options: { all?: boolean }, cb: (...args: unknown[]) => void) {
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

// timeoutMs/lookup are injectable for tests only. The socket 'timeout' below is INACTIVITY-based, so a
// slow-drip server that sends a byte every few seconds never trips it: the absolute timer is what bounds
// the whole request (headers + body) and always settles the promise.
export function once(url: URL, timeoutMs = TIMEOUT_MS, lookup: typeof guardedLookup = guardedLookup): Promise<{ status: number; location?: string; type: string; body: string }> {
  return new Promise((resolveRaw, rejectRaw) => {
    let hard: NodeJS.Timeout | undefined
    const resolve = (v: { status: number; location?: string; type: string; body: string }) => { clearTimeout(hard); resolveRaw(v) }
    const reject = (e: unknown) => { clearTimeout(hard); rejectRaw(e) }
    const req = https.request(
      url,
      { method: 'GET', lookup: lookup as never, timeout: timeoutMs, headers: { 'user-agent': 'dazl-evidence-check/1.0', accept: 'text/html,text/plain;q=0.9', 'accept-encoding': 'identity' } },
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
        res.on('close', () => reject(new Error('aborted'))) // no-op once already settled
      },
    )
    req.on('timeout', () => req.destroy(new Error('timeout')))
    hard = setTimeout(() => { req.destroy(new Error('timeout')); reject(new Error('timeout')) }, timeoutMs)
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

// The page's own publication date from its markup: schema.org datePublished / datePosted (JSON-LD or microdata), article:published_time,
// <time datetime> marked published/pubdate. Modified/updated stamps are update times, not event days, and are never read.
export function publishedDate(html: string): string | null {
  const head = html.slice(0, 400_000)
  const cands: string[] = []
  for (const m of head.matchAll(/"(?:datePublished|datePosted)"\s*:\s*"([^"]{8,40})"/gi)) cands.push(m[1])
  for (const m of head.matchAll(/<meta\b[^>]*?(?:property|name|itemprop)\s*=\s*["'](?:article:published_time|og:published_time|datePublished|datePosted|pubdate|publish[-_]date|date)["'][^>]*?content\s*=\s*["']([^"']{8,40})["']/gi)) cands.push(m[1])
  for (const m of head.matchAll(/<meta\b[^>]*?content\s*=\s*["']([^"']{8,40})["'][^>]*?(?:property|name|itemprop)\s*=\s*["'](?:article:published_time|og:published_time|datePublished|datePosted|pubdate|publish[-_]date)["']/gi)) cands.push(m[1])
  for (const m of head.matchAll(/<time\b[^>]*?(?:pubdate|itemprop\s*=\s*["']datePublished["']|class\s*=\s*["'][^"']*publish[^"']*["'])[^>]*?datetime\s*=\s*["']([^"']{8,40})["']/gi)) cands.push(m[1])
  for (const m of head.matchAll(/<time\b[^>]*?datetime\s*=\s*["']([^"']{8,40})["'][^>]*?(?:pubdate|itemprop\s*=\s*["']datePublished["']|class\s*=\s*["'][^"']*publish[^"']*["'])/gi)) cands.push(m[1])
  for (const c of cands) {
    const d = /^(\d{4})-(\d{2})-(\d{2})/.exec(c.trim()); if (!d) continue
    const y = +d[1], mo = +d[2], da = +d[3]
    const t = new Date(Date.UTC(y, mo - 1, da)); if (y >= 2000 && y <= 2100 && t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === da) return t.toISOString().slice(0, 10)
  }
  return null
}

export function htmlToText(html: string): { text: string; title: string; published: string | null } {
  const title = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '')
  const text = decode(
    html
      .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim()
  return { text, title: title.replace(/\s+/g, ' ').trim().slice(0, 300), published: publishedDate(html) }
}

export type FetchFail = { fail: 'blocked' | 'js_required' | 'not_found' | 'error' | 'refused' }
export const isFail = (r: Page | FetchFail | null): r is FetchFail => !!r && 'fail' in r

const CHALLENGE = /just a moment|attention required|access denied|verify you are (a )?human|are you a robot|captcha|cf-chl|enable javascript and cookies/i
const NEEDS_JS = /enable javascript|requires javascript|javascript is (required|disabled)|you need to enable javascript/i
const EMPTY_SHELL = /<div[^>]+id=["'](root|__next|app|__nuxt)["'][^>]*>\s*<\/div>/i

// Why a page gave us (almost) nothing: a bot wall, or a JavaScript-only shell.
export function classifyThin(html: string, text: string): 'blocked' | 'js_required' | null {
  if (text.length >= 400) return null
  if (CHALLENGE.test(html)) return 'blocked'
  if (NEEDS_JS.test(html) || EMPTY_SHELL.test(html) || (/<script/i.test(html) && text.length < 120)) return 'js_required'
  return null
}

// Optional rendering service (Browserless-compatible POST {SCAN_RENDER_URL}/content), used only
// for pages that came back blocked or JavaScript-only. The browser runs OUTSIDE this process.
// The operator must run it in a network that cannot reach internal addresses: this process
// can check the URL's DNS before handing it over, but cannot control the browser's own lookups.
export async function renderViaService(rawUrl: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const base = process.env.SCAN_RENDER_URL
  if (!base) return null
  try {
    const u = new URL(rawUrl)
    if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return null
    const host = u.hostname.replace(/^\[|\]$/g, '')
    const addrs = isIP(host) ? [host] : (await new Promise<string[]>((res, rej) => dnsLookup(host, { all: true }, (e, a) => (e ? rej(e) : res(a.map(x => x.address)))))) 
    if (addrs.length === 0 || addrs.some(a => !isPublicIp(a))) return null
    const token = process.env.SCAN_RENDER_TOKEN
    const res = await fetchImpl(`${base.replace(/\/$/, '')}/content${token ? `?token=${encodeURIComponent(token)}` : ''}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: u.toString(), gotoOptions: { waitUntil: 'networkidle2', timeout: 20_000 } }),
      signal: AbortSignal.timeout(35_000),
    })
    if (!res.ok) return null
    const html = await res.text()
    return html.length > 0 && html.length <= MAX_BYTES ? html : null
  } catch {
    return null
  }
}

// Fetches a public https page and says why when it cannot. Private addresses are never contacted.
export async function fetchPageDetailed(rawUrl: string, render: (url: string) => Promise<string | null> = renderViaService): Promise<Page | FetchFail> {
  try {
    let url = new URL(rawUrl)
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return { fail: 'refused' }
      const host = url.hostname.replace(/^\[|\]$/g, '')
      if (isIP(host) && !isPublicIp(host)) return { fail: 'refused' }
      const r = await once(url)
      if (r.status >= 300 && r.status < 400) {
        if (!r.location) return { fail: 'error' }
        url = new URL(r.location, url)
        continue
      }
      let thin: 'blocked' | 'js_required' | null = null
      let html = r.body
      if (r.status === 401 || r.status === 403 || r.status === 429) thin = 'blocked'
      else if (r.status === 404 || r.status === 410) return { fail: 'not_found' }
      else if (r.status < 200 || r.status >= 300) return { fail: 'error' }
      else if (!html) return { fail: 'error' }
      else {
        const t = htmlToText(html)
        thin = classifyThin(html, t.text)
        if (!thin) return t.text ? { ...t, retrievedAt: Math.floor(Date.now() / 1000) } : { fail: 'error' }
      }
      // blocked or JavaScript-only: try the rendering service if one is configured
      const rendered = await render(url.toString())
      if (rendered) {
        const t = htmlToText(rendered)
        if (t.text.length >= 200 && !classifyThin(rendered, t.text)) return { ...t, retrievedAt: Math.floor(Date.now() / 1000) }
      }
      return { fail: thin }
    }
    return { fail: 'error' }
  } catch {
    return { fail: 'error' }
  }
}

// Compatibility wrapper: the page, or null on any failure.
export async function safeFetchPage(rawUrl: string): Promise<Page | null> {
  const r = await fetchPageDetailed(rawUrl)
  return isFail(r) ? null : r
}
