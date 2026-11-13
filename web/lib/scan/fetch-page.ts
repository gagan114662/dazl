import { reserveScanSpend, unitCostUsd } from './spend-cap.ts'
import { lookup as dnsLookup } from 'node:dns'
import https from 'node:https'
import { isIP } from 'node:net'
import { brregRecordRef, renderBrregRecord } from '../sources/brreg-record.ts'
import { atsPageText, atsPostingRef, atsRecord, atsRecordUrl, isAtsRecordUrl, type BoardIdentity } from '../sources/ats-posting.ts'
import { socialPostOf, type SocialPost } from './social-post.ts'
import { withAtsReadSlot } from './ats-read-slots.ts' // #1127: at most ATS_RECORD_CONCURRENCY board record reads at a time per scan

// published: the page's OWN publication metadata (never modified/updated), YYYY-MM-DD. postedAt (#533): set only when the
// page is a public ATS board's own API record for exactly this posting URL (lib/sources/ats-posting.ts): the board's
// first-published day for it, the posting's own structured publish date (#460).
// board: set only for a posting read through its board's API record (#1126); the identity the verifier matches instead of the title
// post (#878): set only when the URL names one public social post and the page's own structured data states that post's publish
// time (lib/scan/social-post.ts): its day and its own text. It dates a claim only through socialPostBound.
export interface Page { text: string; title: string; retrievedAt: number; published?: string | null; structured?: string[]; postedAt?: string | null; board?: BoardIdentity; post?: SocialPost }

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
// #533: an Ashby board record lists every posting with its text (Ashby has no single-posting endpoint), so a large
// company's board is bigger than a page; it is read up to this bound. A body cut at the bound does not parse and is a
// failed read, never a page.
const ATS_RECORD_MAX_BYTES = 12_000_000
const MAX_REDIRECTS = 3
const TIMEOUT_MS = Number(process.env.SCAN_PAGE_TIMEOUT_MS || 10_000)
// The PAID render request (reserved 'render' on the scan's spend cap) is given up on after this; exported for the
// stale-running lease floor (lib/scan/store.ts MIN_STALE_RUNNING_S takes the max over the paid call paths).
export const RENDER_TIMEOUT_MS = 35_000

// timeoutMs/lookup are injectable for tests only. The socket 'timeout' below is INACTIVITY-based, so a
// slow-drip server that sends a byte every few seconds never trips it: the absolute timer is what bounds
// the whole request (headers + body) and always settles the promise.
export function once(url: URL, timeoutMs = TIMEOUT_MS, lookup: typeof guardedLookup = guardedLookup, signal?: AbortSignal): Promise<{ status: number; location?: string; type: string; body: string }> {
  if (signal?.aborted) return Promise.reject(new Error('aborted'))   // cancelled before it started: no connection is made
  return new Promise((resolveRaw, rejectRaw) => {
    let hard: NodeJS.Timeout | undefined
    const onAbort = () => { req.destroy(new Error('aborted')); reject(new Error('aborted')) }   // a cancelled / timed-out caller destroys the socket: nothing keeps running behind it
    const resolve = (v: { status: number; location?: string; type: string; body: string }) => { clearTimeout(hard); signal?.removeEventListener('abort', onAbort); resolveRaw(v) }
    const reject = (e: unknown) => { clearTimeout(hard); signal?.removeEventListener('abort', onAbort); rejectRaw(e) }
    const req = https.request(
      url,
      { method: 'GET', lookup: lookup as never, timeout: timeoutMs, headers: { 'user-agent': 'dazl-evidence-check/1.0', accept: jsonRecordUrl(url.toString()) ? 'application/json' : 'text/html,text/plain;q=0.9', 'accept-encoding': 'identity' } },
      res => {
        const status = res.statusCode ?? 0
        const type = String(res.headers['content-type'] ?? '')
        if (status >= 300 && status < 400) {
          res.resume()
          return resolve({ status, location: String(res.headers.location ?? ''), type, body: '' })
        }
        // The only non-HTML documents a page read accepts: the Norway register's own API record for an entity (#763) and a
        // public ATS board's API record for a posting (#533), each rendered below. No other JSON is read.
        const registryRecord = jsonRecordUrl(url.toString()) && /^application\/json\b/i.test(type)
        if (!registryRecord && !/^text\/(html|plain)|application\/xhtml/i.test(type)) {
          res.destroy()
          return resolve({ status, type, body: '' })
        }
        const chunks: Buffer[] = []
        let n = 0
        const cap = isAtsRecordUrl(url.toString()) ? ATS_RECORD_MAX_BYTES : MAX_BYTES
        res.on('data', (c: Buffer) => {
          n += c.length
          if (n > cap) { res.destroy(); resolve({ status, type, body: Buffer.concat(chunks).toString('utf8') }) } else chunks.push(c)
        })
        res.on('end', () => resolve({ status, type, body: Buffer.concat(chunks).toString('utf8') }))
        res.on('error', reject)
        res.on('close', () => reject(new Error('aborted'))) // no-op once already settled
      },
    )
    req.on('timeout', () => req.destroy(new Error('timeout')))
    hard = setTimeout(() => { req.destroy(new Error('timeout')); reject(new Error('timeout')) }, timeoutMs)
    req.on('error', reject)
    if (signal?.aborted) return onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })
    req.end()
  })
}

// #533: several postings of one company cite the same Ashby board record (the whole board): one successful read serves
// them all for a short while, so a scan never downloads the same board once per posting. Only a 2xx answer is kept (a
// refusal, an error or a thrown read is dropped, so the next posting asks again). Public data, keyed by the exact API
// URL; bounded to BOARD_MEMO_BYTES of bodies in total and BOARD_MEMO_MS each. A read in flight is counted once it ends,
// so concurrent reads of different boards can pass the bound briefly (each read is itself capped at ATS_RECORD_MAX_BYTES).
// The shared read is not tied to any one caller's abort signal: a caller whose signal fires stops waiting at once (its
// read fails), and the read goes on for the other callers, ending within the request timeout once it has started. A read
// still queued for a slot (#1127, lib/scan/ats-read-slots.ts) when its LAST caller has given up is never started.
const BOARD_MEMO_MS = 120_000, BOARD_MEMO_BYTES = 24_000_000
type BoardEntry = { at: number; read: ReturnType<typeof once>; bytes: number; waiting: number; idle: () => void }
const boardMemo = new Map<string, BoardEntry>()
const memoBytes = () => [...boardMemo.values()].reduce((a, m) => a + m.bytes, 0)
// One caller's wait on the shared read: a caller with no signal waits for it to settle; one with a signal leaves on abort.
function awaitBoard(entry: BoardEntry, signal?: AbortSignal): ReturnType<typeof once> {
  if (signal?.aborted) return Promise.reject(new Error('aborted'))
  entry.waiting++
  if (!signal) return entry.read
  return new Promise((resolve, reject) => {
    const onAbort = () => { if (--entry.waiting === 0) entry.idle(); reject(new Error('aborted')) }
    signal.addEventListener('abort', onAbort, { once: true })
    entry.read.then(v => { signal.removeEventListener('abort', onAbort); resolve(v) }, e => { signal.removeEventListener('abort', onAbort); reject(e) })
  })
}
function boardRead(url: URL, signal?: AbortSignal): ReturnType<typeof once> {
  const k = url.toString(), now = Date.now()
  for (const [key, m] of boardMemo) if (now - m.at > BOARD_MEMO_MS) boardMemo.delete(key)
  const hit = boardMemo.get(k)
  if (hit) return awaitBoard(hit, signal)
  if (signal?.aborted) return Promise.reject(new Error('aborted'))
  // shared, so not tied to one caller's abort signal; queued for a slot of this scan (#1127) and left unstarted once no caller
  // waits any more (idle); the request timeout starts when the read does
  const queued = new AbortController(), state = { started: false }
  const read = withAtsReadSlot(() => { state.started = true; return once(url, TIMEOUT_MS, guardedLookup) }, queued.signal)
  const entry: BoardEntry = { at: now, read, bytes: 0, waiting: 0, idle: () => { if (state.started) return; if (boardMemo.get(k) === entry) boardMemo.delete(k); queued.abort() } }
  boardMemo.set(k, entry)
  read.then(r => {
    if (r.status < 200 || r.status >= 300) { boardMemo.delete(k); return }
    entry.bytes = r.body.length
    // oldest first until the bodies kept fit the bound (this one included: a single board over the bound is not kept)
    for (const key of boardMemo.keys()) { if (memoBytes() <= BOARD_MEMO_BYTES) break; boardMemo.delete(key) }
  }, () => { if (boardMemo.get(k) === entry) boardMemo.delete(k) })
  return awaitBoard(entry, signal)
}
export const resetBoardMemo = () => boardMemo.clear()

const jsonRecordUrl = (u: string): boolean => !!brregRecordRef(u) || isAtsRecordUrl(u)

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
// exported (#767): the careers adapter quotes Greenhouse content from exactly this rendering, so its quote is on the verifier's page
export function decode(s: string): string {
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
  // Exactly ONE distinct publication day across all of the page's markup. Two or more (a news list, several articles, an unrelated JSON-LD
  // entity beside the page's own) mean none of them can be tied to this quote, so none is reported.
  const days = new Set<string>()
  for (const c of cands) {
    const d = /^(\d{4})-(\d{2})-(\d{2})/.exec(c.trim()); if (!d) continue
    const y = +d[1], mo = +d[2], da = +d[3]
    const t = new Date(Date.UTC(y, mo - 1, da)); if (y >= 2000 && y <= 2100 && t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === da) days.add(t.toISOString().slice(0, 10))
  }
  return days.size === 1 ? [...days][0] : null
}

// The raw schema.org JSON-LD blocks of a page (capped), kept so a dated entity the page itself declares (an Event's startDate, a JobPosting's datePosted) can be read later by scan/structured-date.ts.
export function ldJsonBlocks(html: string): string[] {
  const out: string[] = []
  for (const m of html.slice(0, 600_000).matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) { if (m[1].length <= 40_000) out.push(m[1]); if (out.length >= 8) break }
  return out
}
export function htmlToText(html: string): { text: string; title: string; published: string | null; structured: string[] } {
  const title = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '')
  const text = decode(
    html
      .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim()
  return { text, title: title.replace(/\s+/g, ' ').trim().slice(0, 300), published: publishedDate(html), structured: ldJsonBlocks(html) }
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
    // Inside a scan: one render reserved on the scan's spend cap first (lib/scan/spend-cap.ts); a refusal is caught
    // below and renders nothing.
    const hold = await reserveScanSpend('render', () => unitCostUsd('render', 1))
    let res: Response
    try {
      res = await fetchImpl(`${base.replace(/\/$/, '')}/content${token ? `?token=${encodeURIComponent(token)}` : ''}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: u.toString(), gotoOptions: { waitUntil: 'networkidle2', timeout: 20_000 } }),
        signal: AbortSignal.timeout(RENDER_TIMEOUT_MS),
      })
    } catch (e) { hold?.uncertain(); throw e } // timeout / dropped connection after send: may have been billed, the row stays 'reserved' and the attempt stops paying (#363)
    if (hold) { if (res.ok || [400, 401, 403, 404, 413, 429].includes(res.status)) { await hold.settle(res.ok ? hold.usd : null); if (!res.ok) hold.rejected(res.status) } else hold.uncertain() }
    if (!res.ok) return null
    const html = await res.text()
    return html.length > 0 && html.length <= MAX_BYTES ? html : null
  } catch {
    return null
  }
}

// #878: the social post the cited URL names, when the page read (after redirects, still that post) states its own publish time
const postOf = (rawUrl: string, url: URL, html: string): { post?: SocialPost } => { const post = socialPostOf(rawUrl, url.toString(), html); return post ? { post } : {} }

// Fetches a public https page and says why when it cannot. Private addresses are never contacted.
export async function fetchPageDetailed(rawUrl: string, render: (url: string) => Promise<string | null> = renderViaService, signal?: AbortSignal): Promise<Page | FetchFail> {
  // #533: a posting on a public ATS board is read from the board's own API record, never from the posting page
  const posting = atsPostingRef(rawUrl)
  try {
    let url = new URL(posting ? atsRecordUrl(posting) : rawUrl)
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return { fail: 'refused' }
      const host = url.hostname.replace(/^\[|\]$/g, '')
      if (isIP(host) && !isPublicIp(host)) return { fail: 'refused' }
      if (signal?.aborted) return { fail: 'error' }
      // #1127: every request leg to a board API host takes a slot of this scan (a translated posting, a direct API URL, a redirect onto the API host)
      const r = posting?.kind === 'ashby' && i === 0 ? await boardRead(url, signal) : isAtsRecordUrl(url.toString()) ? await withAtsReadSlot(() => once(url, TIMEOUT_MS, guardedLookup, signal), signal) : await once(url, TIMEOUT_MS, guardedLookup, signal)
      if (r.status >= 300 && r.status < 400) {
        if (!r.location) return { fail: 'error' }
        url = new URL(r.location, url)
        if (posting && !isAtsRecordUrl(url.toString())) return { fail: 'error' } // a posting's record is never followed off the board API hosts
        continue
      }
      let thin: 'blocked' | 'js_required' | null = null
      let html = r.body
      if (r.status === 401 || r.status === 403 || r.status === 429) thin = 'blocked'
      else if (r.status === 404 || r.status === 410) return { fail: 'not_found' }
      else if (r.status < 200 || r.status >= 300) return { fail: 'error' }
      else if (!html) return { fail: 'error' }
      else if (posting) {
        // Only the record of exactly this posting, with its first-published day; a board that no longer lists it is a closed posting (not found). Any other answer
        // (HTML, a redirect to a foreign host) is a failed read, never a page.
        if (!/^application\/json\b/i.test(r.type) || !isAtsRecordUrl(url.toString())) return { fail: 'error' }
        let body: unknown = null
        try { body = JSON.parse(html) } catch { return { fail: 'error' } }
        const rec = atsRecord(body, posting)
        if (rec === 'missing') return { fail: 'not_found' }
        if (!rec) return { fail: 'error' }
        const page = atsPageText(rec, rec.html ? htmlToText(decode(rec.description)).text : rec.description)
        return { text: page.text, title: page.title, board: page.board, retrievedAt: Math.floor(Date.now() / 1000), published: rec.posted, postedAt: rec.posted, structured: [] } // posted null: an undated page
      } else if (/^application\/json\b/i.test(r.type)) {
        // Only reachable for a registry record URL (once() empties every other non-HTML body). The record must be the entity the URL names and carry its registration date.
        const ref = brregRecordRef(rawUrl) ? brregRecordRef(url.toString()) : null; let rec: ReturnType<typeof renderBrregRecord> = null // a foreign URL that redirects to a record does not borrow the record's date
        try { rec = ref ? renderBrregRecord(JSON.parse(html), ref.id) : null } catch { rec = null }
        return rec ? { text: rec.text, title: rec.title, retrievedAt: Math.floor(Date.now() / 1000), published: null, structured: [] } : { fail: 'error' }
      } else {
        const t = htmlToText(html)
        thin = classifyThin(html, t.text)
        if (!thin) return t.text ? { ...t, retrievedAt: Math.floor(Date.now() / 1000), ...postOf(rawUrl, url, html) } : { fail: 'error' }
      }
      // a board API that refused the record is a refusal: never sent to the rendering service
      if (posting) return { fail: thin ?? 'error' }
      // blocked or JavaScript-only: try the rendering service if one is configured
      const rendered = await render(url.toString())
      if (rendered) {
        const t = htmlToText(rendered)
        if (t.text.length >= 200 && !classifyThin(rendered, t.text)) return { ...t, retrievedAt: Math.floor(Date.now() / 1000), ...postOf(rawUrl, url, rendered) }
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
